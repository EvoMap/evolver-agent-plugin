import assert from 'node:assert/strict';
import { test } from 'node:test';

import { recallStrategy } from '../lib/recall.js';

const PROMPT = 'set up retry with backoff for the flaky upload client';
const RECIPE = {
  id: 'rcp_upload',
  title: 'Harden a flaky upload client',
  description: 'Retry uploads with backoff, then alert when retries run out',
  price_per_execution: 5,
  success_rate: 0.9,
  steps: [
    { asset_id: 'sha256:alert', asset_type: 'Gene', position: 2, optional: false },
    { asset_id: 'sha256:retry', asset_type: 'Gene', position: 1, optional: false },
    { asset_id: 'sha256:docs', asset_type: 'Gene', position: 3, optional: true },
  ],
};
const STEP_ASSETS = [
  { asset_id: 'sha256:retry', short_title: 'Retry with jittered backoff', strategy: ['Wrap the call', 'Back off with jitter', 'Cap the attempts'] },
  { asset_id: 'sha256:alert', short_title: 'Alert on exhausted retries', strategy: ['Count exhausted retries', 'Page when the rate climbs'] },
];
const GENE = {
  asset_id: 'sha256:gene', summary: 'Retry the upload with backoff.', signals_match: ['upload retry backoff'],
  strategy: ['Measure the failure rate first.', 'Add jittered backoff.', 'Cap the retries.', 'Alert on the cap.'],
};

function proxy({ recipes = [RECIPE], stepAssets = STEP_ASSETS, gene = GENE } = {}) {
  const calls = [];
  const proxyFetch = async (method, path, body) => {
    calls.push({ path, body });
    if (path === '/recipe/search') return { ok: true, data: { recipes, query: body.q } };
    if (body?.asset_ids) return { ok: true, data: { assets: stepAssets.filter((asset) => body.asset_ids.includes(asset.asset_id)) } };
    return { ok: true, data: { assets: gene ? [gene] : [] } };
  };
  return { proxyFetch, calls, stepFetches: () => calls.filter((call) => call.body?.asset_ids) };
}

test('a relevant Recipe is expanded in step order and preferred over a single strategy', async () => {
  const { proxyFetch, calls, stepFetches } = proxy();
  const traces = [];
  const match = await recallStrategy(proxyFetch, PROMPT, { onTrace: (trace) => traces.push(trace) });
  assert.deepEqual(match.ids, ['sha256:retry', 'sha256:alert']);
  assert.equal(match.name, 'Harden a flaky upload client');
  assert.match(match.text, /^\[Evolution Memory\] Recipe: Harden a flaky upload client \(EvoMap network, 2 steps, in order\):/);
  assert.match(match.text, /Step 1 — Retry with jittered backoff:\n1\. Wrap the call\n2\. Back off with jitter\n3\. Cap the attempts\n\nStep 2 — Alert on exhausted retries:/);
  assert.match(match.text, /\n\nApply it where it fits\. Evolver reports how the reuse of rcp_upload went when this turn ends\.$/);
  assert.deepEqual(match.stepTexts, {
    'sha256:retry': '[Evolution Memory] Retry with jittered backoff (EvoMap network):\n1. Wrap the call\n2. Back off with jitter\n3. Cap the attempts',
    'sha256:alert': '[Evolution Memory] Alert on exhausted retries (EvoMap network):\n1. Count exhausted retries\n2. Page when the rate climbs',
  });
  assert.deepEqual(stepFetches().map((call) => call.body), [{ asset_ids: ['sha256:retry', 'sha256:alert', 'sha256:docs'] }]);
  assert.deepEqual(calls.find((call) => call.path === '/recipe/search').body, { q: PROMPT, limit: 5 });
  assert.deepEqual(traces.at(-1), { outcome: 'injected', kind: 'recipe', name: 'Harden a flaky upload client', steps: 2, relevance: 5 });
});

test('a Recipe closes with the caller\'s closing line', async () => {
  const match = await recallStrategy(proxy().proxyFetch, PROMPT, { closingOf: () => 'Apply them where they fit.' });
  assert.ok(match.text.endsWith('\n\nApply them where they fit.'));
});

test('a Recipe missing a required step, or off topic, gives way to the single strategy', async () => {
  const missing = await recallStrategy(proxy({ stepAssets: STEP_ASSETS.slice(0, 1) }).proxyFetch, PROMPT);
  assert.deepEqual(missing.ids, ['sha256:gene']);
  assert.equal(missing.stepTexts, undefined);
  const offTopic = proxy({ recipes: [{ ...RECIPE, title: 'Rotate database credentials', description: 'Vault leases' }] });
  assert.deepEqual((await recallStrategy(offTopic.proxyFetch, PROMPT)).ids, ['sha256:gene']);
  assert.deepEqual(offTopic.stepFetches(), [], 'an off-topic Recipe costs no fetch');
});

test('a Recipe of one step is no chain, and one too long to read as an approach gives way to the next', async () => {
  const single = proxy({ recipes: [{ ...RECIPE, steps: RECIPE.steps.slice(1, 2) }] });
  assert.deepEqual((await recallStrategy(single.proxyFetch, PROMPT)).ids, ['sha256:gene']);
  assert.deepEqual(single.stepFetches(), []);

  const longLines = Array.from({ length: 8 }, (_, index) => `${index} ${'x'.repeat(398)}`);
  const long = { ...RECIPE, id: 'rcp_long', success_rate: 1, steps: [{ asset_id: 'sha256:l1', position: 1 }, { asset_id: 'sha256:l2', position: 2 }] };
  const stepAssets = [...STEP_ASSETS, { asset_id: 'sha256:l1', strategy: longLines }, { asset_id: 'sha256:l2', strategy: longLines }];
  const both = proxy({ recipes: [RECIPE, long], stepAssets });
  const match = await recallStrategy(both.proxyFetch, PROMPT);
  assert.deepEqual(both.stepFetches().map((call) => call.body.asset_ids[0]), ['sha256:l1', 'sha256:retry'], 'the better-rated one was tried first');
  assert.deepEqual(match.ids, ['sha256:retry', 'sha256:alert']);
});

test('a Recipe whose required steps were all listed already is passed over without fetching them again', async () => {
  const { proxyFetch, stepFetches } = proxy();
  const match = await recallStrategy(proxyFetch, PROMPT, { listedIds: new Set(['sha256:retry', 'sha256:alert']) });
  assert.deepEqual(match.ids, ['sha256:gene']);
  assert.deepEqual(stepFetches(), [], 'its missing optional step alone does not make it new');
});

test('a Recipe with one step not listed yet is offered whole', async () => {
  const match = await recallStrategy(proxy().proxyFetch, PROMPT, { listedIds: new Set(['sha256:retry']) });
  assert.deepEqual(match.ids, ['sha256:retry', 'sha256:alert']);
});

test('a Proxy without Recipe search still recalls a single strategy', async () => {
  const proxyFetch = async (method, path) => (path === '/recipe/search' ? { ok: false, error: 'HTTP 404' } : { ok: true, data: { assets: [GENE] } });
  assert.deepEqual((await recallStrategy(proxyFetch, PROMPT)).ids, ['sha256:gene']);
  const throwing = async (method, path) => {
    if (path === '/recipe/search') throw new Error('ECONNRESET');
    return { ok: true, data: { assets: [GENE] } };
  };
  assert.deepEqual((await recallStrategy(throwing, PROMPT)).ids, ['sha256:gene']);
});

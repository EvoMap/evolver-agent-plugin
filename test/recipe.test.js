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
    if (path === '/recipe/search') return { ok: true, data: recipes };
    if (body?.asset_ids) return { ok: true, data: { assets: stepAssets.filter((asset) => body.asset_ids.includes(asset.asset_id)) } };
    return { ok: true, data: { assets: gene ? [gene] : [] } };
  };
  const stepFetches = () => calls.filter((call) => call.body?.asset_ids);
  return { proxyFetch, calls, stepFetches };
}

test('a relevant Recipe is expanded in step order and preferred over a single strategy', async () => {
  const { proxyFetch, calls, stepFetches } = proxy();
  const traces = [];
  const match = await recallStrategy(proxyFetch, PROMPT, { onTrace: (trace) => traces.push(trace) });
  assert.deepEqual(match.ids, ['sha256:retry', 'sha256:alert']);
  assert.equal(match.name, 'Harden a flaky upload client');
  assert.match(match.text, /^\[Evolution Memory\] Recipe: Harden a flaky upload client \(EvoMap network, 2 steps, in order\):/);
  assert.match(match.text, /Step 1 — Retry with jittered backoff:\n1\. Wrap the call\n2\. Back off with jitter\n3\. Cap the attempts\n\nStep 2 — Alert on exhausted retries:/);
  assert.match(match.text, /Follow the steps in order\. Apply it where it fits\. Evolver reports how the reuse of rcp_upload went when this turn ends\.$/);
  assert.deepEqual(stepFetches()[0].body, { asset_ids: ['sha256:retry', 'sha256:alert', 'sha256:docs'] });
  assert.deepEqual(calls.find((call) => call.path === '/recipe/search').body, { q: PROMPT, limit: 5 });
  assert.deepEqual(traces.at(-1), { outcome: 'injected', kind: 'recipe', name: 'Harden a flaky upload client', steps: 2, relevance: traces.at(-1).relevance });
});

test('each step keeps its own text, read as a single strategy of that name', async () => {
  const match = await recallStrategy(proxy().proxyFetch, PROMPT);
  assert.deepEqual(match.stepTexts, {
    'sha256:retry': '[Evolution Memory] Retry with jittered backoff (EvoMap network):\n1. Wrap the call\n2. Back off with jitter\n3. Cap the attempts',
    'sha256:alert': '[Evolution Memory] Alert on exhausted retries (EvoMap network):\n1. Count exhausted retries\n2. Page when the rate climbs',
  });
});

test('the caller\'s closing ends a Recipe too', async () => {
  const match = await recallStrategy(proxy().proxyFetch, PROMPT, { closingOf: () => 'Apply them where they fit.' });
  assert.ok(match.text.endsWith('\n\nFollow the steps in order. Apply them where they fit.'));
});

test('a Recipe missing a required step, or off topic, gives way to the single strategy', async () => {
  const missing = await recallStrategy(proxy({ stepAssets: STEP_ASSETS.slice(0, 1) }).proxyFetch, PROMPT);
  assert.deepEqual(missing.ids, ['sha256:gene']);
  const offTopic = proxy({ recipes: [{ ...RECIPE, title: 'Rotate database credentials', description: 'Vault leases' }] });
  assert.deepEqual((await recallStrategy(offTopic.proxyFetch, PROMPT)).ids, ['sha256:gene']);
  assert.deepEqual(offTopic.stepFetches(), [], 'an off-topic Recipe costs no step fetch');
});

test('a Recipe whose required steps the session has seen is passed over without fetching its steps', async () => {
  const seen = proxy();
  const match = await recallStrategy(seen.proxyFetch, PROMPT, { listedIds: new Set(['sha256:retry', 'sha256:alert']) });
  assert.deepEqual(match.ids, ['sha256:gene']);
  assert.deepEqual(seen.stepFetches(), []);
});

test('a Recipe with one required step unseen is offered whole, its seen steps included', async () => {
  const match = await recallStrategy(proxy().proxyFetch, PROMPT, { listedIds: new Set(['sha256:retry']) });
  assert.deepEqual(match.ids, ['sha256:retry', 'sha256:alert']);
});

test('a Recipe of optional steps that shows only seen ones is passed over', async () => {
  const optional = { ...RECIPE, steps: RECIPE.steps.map((step) => ({ ...step, optional: true })) };
  const match = await recallStrategy(proxy({ recipes: [optional] }).proxyFetch, PROMPT, { listedIds: new Set(['sha256:retry', 'sha256:alert']) });
  assert.deepEqual(match.ids, ['sha256:gene']);
});

test('only the best Recipe is fetched; when it cannot be expanded the single strategy is used', async () => {
  const hollow = { ...RECIPE, id: 'rcp_hollow', success_rate: 0.99, steps: [{ asset_id: 'sha256:gone', position: 1 }, { asset_id: 'sha256:also-gone', position: 2 }] };
  const stub = proxy({ recipes: [hollow, RECIPE] });
  const match = await recallStrategy(stub.proxyFetch, PROMPT);
  assert.deepEqual(match.ids, ['sha256:gene']);
  assert.equal(stub.stepFetches().length, 1, 'one step fetch per prompt, however many Recipes fit');
});

test('a Recipe still pending at the cutoff gives way to the single strategy that is ready', async () => {
  let answerSearch;
  const searched = new Promise((resolve) => { answerSearch = resolve; });
  const proxyFetch = async (method, path, body) => {
    if (path === '/recipe/search') return searched;
    if (body?.asset_ids) return { ok: true, data: { assets: STEP_ASSETS } };
    return { ok: true, data: { assets: [GENE] } };
  };
  const match = await recallStrategy(proxyFetch, PROMPT, { recipeCutoff: Promise.resolve() });
  assert.deepEqual(match.ids, ['sha256:gene']);
  answerSearch({ ok: true, data: [RECIPE] });
  assert.deepEqual((await recallStrategy(proxy().proxyFetch, PROMPT, { recipeCutoff: new Promise(() => {}) })).ids, ['sha256:retry', 'sha256:alert'], 'one that lands first still wins');
});

test('a Proxy without Recipe search still recalls a single strategy', async () => {
  const proxyFetch = async (method, path) => (path === '/recipe/search' ? { ok: false, error: 'HTTP 501' } : { ok: true, data: { assets: [GENE] } });
  assert.deepEqual((await recallStrategy(proxyFetch, PROMPT)).ids, ['sha256:gene']);
});

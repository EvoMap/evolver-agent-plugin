import assert from 'node:assert/strict';
import { test } from 'node:test';

import { recallStrategy } from '../lib/recall.js';
import { recipeSearchAnswer } from './helpers/recipe-search.js';

const PROMPT = 'set up retry with backoff for the flaky upload client';
const CONTEXT = { task: PROMPT, trigger: 'turn_start' };
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

function proxy({ recipes = [RECIPE], stepAssets = STEP_ASSETS, gene = GENE, judged = true } = {}) {
  const calls = [];
  const proxyFetch = async (method, path, body) => {
    calls.push({ path, body });
    if (path === '/recipe/search') return { ok: true, data: judged ? recipeSearchAnswer(recipes, body) : { recipes } };
    if (body?.asset_ids) return { ok: true, data: { assets: stepAssets.filter((asset) => body.asset_ids.includes(asset.asset_id)) } };
    return { ok: true, data: { assets: gene ? [gene] : [] } };
  };
  const stepFetches = () => calls.filter((call) => call.body?.asset_ids);
  return { proxyFetch, calls, stepFetches };
}

const recalled = (proxyFetch, options = {}) => recallStrategy(proxyFetch, PROMPT, { context: CONTEXT, ...options });

test('a relevant Recipe is expanded in step order and preferred over a single strategy', async () => {
  const { proxyFetch, calls, stepFetches } = proxy();
  const traces = [];
  const match = await recalled(proxyFetch, { onTrace: (trace) => traces.push(trace) });
  assert.deepEqual(match.ids, ['sha256:retry', 'sha256:alert']);
  assert.equal(match.name, 'Harden a flaky upload client');
  assert.match(match.text, /^\[Evolution Memory\] Recipe: Harden a flaky upload client \(EvoMap network, 2 steps, in order\):/);
  assert.match(match.text, /Step 1 — Retry with jittered backoff:\n1\. Wrap the call\n2\. Back off with jitter\n3\. Cap the attempts\n\nStep 2 — Alert on exhausted retries:/);
  assert.match(match.text, /Follow the steps in order\. Apply it where it fits\. Evolver reports how the reuse of rcp_upload went when this turn ends\.$/);
  assert.deepEqual(stepFetches()[0].body, { asset_ids: ['sha256:retry', 'sha256:alert', 'sha256:docs'] });
  assert.deepEqual(calls.find((call) => call.path === '/recipe/search').body, { q: PROMPT, limit: 5, context: CONTEXT });
  assert.deepEqual(traces.at(-1), { outcome: 'injected', kind: 'recipe', name: 'Harden a flaky upload client', steps: 2, fit: 0.8 });
});

test('each step keeps its own text, read as a single strategy of that name', async () => {
  const match = await recalled(proxy().proxyFetch);
  assert.deepEqual(match.stepTexts, {
    'sha256:retry': '[Evolution Memory] Retry with jittered backoff (EvoMap network):\n1. Wrap the call\n2. Back off with jitter\n3. Cap the attempts',
    'sha256:alert': '[Evolution Memory] Alert on exhausted retries (EvoMap network):\n1. Count exhausted retries\n2. Page when the rate climbs',
  });
});

test('the caller\'s closing ends a Recipe too', async () => {
  const match = await recalled(proxy().proxyFetch, { closingOf: () => 'Apply them where they fit.' });
  assert.ok(match.text.endsWith('\n\nFollow the steps in order. Apply them where they fit.'));
});

test('a Recipe missing a required step, or not kept by the Hub, gives way to the single strategy', async () => {
  const missing = await recalled(proxy({ stepAssets: STEP_ASSETS.slice(0, 1) }).proxyFetch);
  assert.deepEqual(missing.ids, ['sha256:gene']);
  const unfit = proxy({ recipes: [] });
  assert.deepEqual((await recalled(unfit.proxyFetch)).ids, ['sha256:gene']);
  assert.deepEqual(unfit.stepFetches(), [], 'a Recipe the Hub judged unfit costs no step fetch');
});

test('an unjudged Recipe answer, as through a Proxy that drops the context, injects no Recipe however its words match', async () => {
  const unjudged = proxy({ judged: false });
  assert.deepEqual((await recalled(unjudged.proxyFetch)).ids, ['sha256:gene']);
  assert.deepEqual(unjudged.stepFetches(), []);
});

test('without a task to judge against, no Recipe is searched', async () => {
  const stub = proxy();
  assert.deepEqual((await recallStrategy(stub.proxyFetch, PROMPT)).ids, ['sha256:gene']);
  assert.equal(stub.calls.some((call) => call.path === '/recipe/search'), false);
});

test('of the Recipes the Hub kept, the best fit to the task is offered', async () => {
  const better = { ...RECIPE, id: 'rcp_better', title: 'Retry, then alert', success_rate: 0.1, context_fit: 0.95 };
  const match = await recalled(proxy({ recipes: [{ ...RECIPE, context_fit: 0.6 }, better] }).proxyFetch);
  assert.equal(match.name, 'Retry, then alert');
});

test('a Recipe whose required steps the session has seen is passed over without fetching its steps', async () => {
  const seen = proxy();
  const match = await recalled(seen.proxyFetch, { listedIds: new Set(['sha256:retry', 'sha256:alert']) });
  assert.deepEqual(match.ids, ['sha256:gene']);
  assert.deepEqual(seen.stepFetches(), []);
});

test('a Recipe with one required step unseen is offered whole, its seen steps included', async () => {
  const match = await recalled(proxy().proxyFetch, { listedIds: new Set(['sha256:retry']) });
  assert.deepEqual(match.ids, ['sha256:retry', 'sha256:alert']);
});

test('a Recipe of optional steps that shows only seen ones is passed over', async () => {
  const optional = { ...RECIPE, steps: RECIPE.steps.map((step) => ({ ...step, optional: true })) };
  const match = await recalled(proxy({ recipes: [optional] }).proxyFetch, { listedIds: new Set(['sha256:retry', 'sha256:alert']) });
  assert.deepEqual(match.ids, ['sha256:gene']);
});

test('only the best Recipe is fetched; when it cannot be expanded the single strategy is used', async () => {
  const hollow = { ...RECIPE, id: 'rcp_hollow', success_rate: 0.99, steps: [{ asset_id: 'sha256:gone', position: 1 }, { asset_id: 'sha256:also-gone', position: 2 }] };
  const stub = proxy({ recipes: [hollow, RECIPE] });
  const match = await recalled(stub.proxyFetch);
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
  const match = await recalled(proxyFetch, { recipeCutoff: Promise.resolve() });
  assert.deepEqual(match.ids, ['sha256:gene']);
  answerSearch({ ok: true, data: recipeSearchAnswer([RECIPE], { context: CONTEXT }) });
  assert.deepEqual((await recalled(proxy().proxyFetch, { recipeCutoff: new Promise(() => {}) })).ids, ['sha256:retry', 'sha256:alert'], 'one that lands first still wins');
});

test('a Proxy without Recipe search still recalls a single strategy', async () => {
  const proxyFetch = async (method, path) => (path === '/recipe/search' ? { ok: false, error: 'HTTP 501' } : { ok: true, data: { assets: [GENE] } });
  assert.deepEqual((await recalled(proxyFetch)).ids, ['sha256:gene']);
});

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
  return { proxyFetch, calls };
}

test('a relevant Recipe is expanded in step order and preferred over a single strategy', async () => {
  const { proxyFetch, calls } = proxy();
  const traces = [];
  const match = await recallStrategy(proxyFetch, PROMPT, { onTrace: (trace) => traces.push(trace) });
  assert.deepEqual(match.ids, ['sha256:retry', 'sha256:alert']);
  assert.equal(match.recipeId, 'rcp_upload');
  assert.match(match.text, /^\[Evolution Memory\] Recipe: Harden a flaky upload client \(EvoMap network, 2 steps, in order\):/);
  assert.match(match.text, /Step 1 — Retry with jittered backoff:\n1\. Wrap the call\n2\. Back off with jitter\n3\. Cap the attempts\n\nStep 2 — Alert on exhausted retries:/);
  assert.match(match.text, /reuse of recipe rcp_upload went when this turn ends\.$/);
  assert.deepEqual(match.stepTexts, { 'sha256:retry': '1. Wrap the call\n2. Back off with jitter\n3. Cap the attempts', 'sha256:alert': '1. Count exhausted retries\n2. Page when the rate climbs' });
  assert.deepEqual(calls.find((call) => call.body?.asset_ids).body, { asset_ids: ['sha256:retry', 'sha256:alert', 'sha256:docs'] });
  assert.deepEqual(calls.find((call) => call.path === '/recipe/search').body, { q: PROMPT, limit: 5 });
  assert.equal(traces.at(-1).kind, 'recipe');
});

test('a Recipe missing a required step, or off topic, gives way to the single strategy', async () => {
  const missing = await recallStrategy(proxy({ stepAssets: STEP_ASSETS.slice(0, 1) }).proxyFetch, PROMPT);
  assert.deepEqual(missing.ids, ['sha256:gene']);
  const offTopic = await recallStrategy(proxy({ recipes: [{ ...RECIPE, title: 'Rotate database credentials', description: 'Vault leases' }] }).proxyFetch, PROMPT);
  assert.deepEqual(offTopic.ids, ['sha256:gene']);
});

test('a Recipe whose steps were all injected already is passed over', async () => {
  const match = await recallStrategy(proxy().proxyFetch, PROMPT, { listedIds: new Set(['sha256:retry', 'sha256:alert', 'sha256:docs']) });
  assert.deepEqual(match.ids, ['sha256:gene']);
});

test('a Proxy without Recipe search still recalls a single strategy', async () => {
  const proxyFetch = async (method, path, body) => (path === '/recipe/search' ? { ok: false, error: 'HTTP 501' } : { ok: true, data: { assets: [GENE] } });
  assert.deepEqual((await recallStrategy(proxyFetch, PROMPT)).ids, ['sha256:gene']);
});

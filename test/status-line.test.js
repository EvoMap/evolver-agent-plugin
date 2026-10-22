import assert from 'node:assert/strict';
import { test } from 'node:test';

import { recallStrategy } from '../lib/recall.js';
import { recallStatusOf, statusLineOf } from '../lib/status-line.js';

const STRATEGY = ['Pool the connections.', 'Bound the wait.', 'Retry with backoff.', 'Alert on exhaustion.'];

async function traced(text, data) {
  const traces = [];
  await recallStrategy(async () => (data === undefined ? { ok: false, error: 'down' } : { ok: true, data }), text, { onTrace: (t) => traces.push(t) });
  return traces;
}

test('every recall reports exactly one decision', async () => {
  assert.deepEqual(await traced('fix it', { assets: [] }), [{ outcome: 'short' }]);
  assert.deepEqual(await traced('redis connection pool timeout', undefined), [{ outcome: 'unavailable' }]);

  const [injected] = await traced('redis connection pool timeout', {
    assets: [{ asset_id: 'sha256:r', short_title: 'Redis connection pool tuning', strategy: STRATEGY }],
  });
  assert.equal(injected.outcome, 'injected');
  assert.equal(injected.recalled, 1);
  assert.equal(injected.relevance, 3);

  const [skipped] = await traced('还有多少没有对齐？', {
    assets: [{ asset_id: 'sha256:n', short_title: 'Naming registry scanner', strategy: STRATEGY }],
  });
  assert.deepEqual(skipped, { outcome: 'skipped', recalled: 1, eligible: 0, bestRelevance: 0 });
});

test('a recall decision reads as one short status phrase', () => {
  assert.equal(recallStatusOf({ outcome: 'skipped', recalled: 5, eligible: 0, bestRelevance: 1 }), 'recall: 5 hits, best relevance 1 (needs 2), none injected');
  assert.equal(recallStatusOf({ outcome: 'skipped', recalled: 0, eligible: 0, bestRelevance: 0 }), 'recall: no assets came back');
  assert.equal(recallStatusOf({ outcome: 'injected', recalled: 5, name: 'Redis pool', relevance: 2 }), 'recall: injected "Redis pool" (5 hits, relevance 2)');
  assert.equal(recallStatusOf({ outcome: 'waiting', waitedMs: 6000 }), 'recall: still waiting after 6s, lands next step');
});

test('the status line joins what is known and clears when nothing is', () => {
  assert.equal(
    statusLineOf([recallStatusOf({ outcome: 'short' })]),
    'evolver · recall: prompt too short',
  );
  assert.equal(statusLineOf([null]), undefined);
});

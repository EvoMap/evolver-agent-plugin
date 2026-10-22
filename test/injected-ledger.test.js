import assert from 'node:assert/strict';
import { test } from 'node:test';

import { unreportedAssets, withInjected, withReported } from '../lib/injected-ledger.js';

const DAY = 24 * 60 * 60 * 1000;

test('an injection keeps its turn and strategy until reported', () => {
  const ledger = withInjected({}, 'sha256:a', { turn: 2, strategyText: '1. Step' }, 0);
  assert.deepEqual(unreportedAssets(ledger, 2), [{ assetId: 'sha256:a', strategyText: '1. Step' }]);
  assert.deepEqual(unreportedAssets(withReported(ledger, ['sha256:a'], 1), 2), []);
});

test('an asset is recorded once per session', () => {
  const first = withInjected({}, 'sha256:a', { turn: 1, strategyText: 'one' }, 0);
  assert.equal(withInjected(first, 'sha256:a', { turn: 3, strategyText: 'two' }, 1)['sha256:a'].turn, 1);
});

test('a strategy that lands after its turn ended is reported at the next turn end', () => {
  const ledger = withInjected({}, 'sha256:a', { turn: 2, strategyText: '' }, 0);
  assert.deepEqual(unreportedAssets(ledger, 1), []);
  assert.equal(unreportedAssets(ledger, 3).length, 1);
});

test('entries older than a week are pruned', () => {
  const ledger = withInjected({}, 'sha256:old', { turn: 1, strategyText: '' }, 0);
  assert.deepEqual(Object.keys(withInjected(ledger, 'sha256:new', { turn: 2, strategyText: '' }, 8 * DAY)), ['sha256:new']);
});

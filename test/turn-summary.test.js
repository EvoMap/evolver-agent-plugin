import assert from 'node:assert/strict';
import { test } from 'node:test';

import { referenceReuseSavings } from '../lib/savings.js';
import { turnSummaryOf } from '../lib/turn-summary.js';

const USAGE = { input_tokens: 1_200, output_tokens: 800, cache_creation_input_tokens: 4_000, cache_read_input_tokens: 25_000 };

test('savings follow evolver-core savingsCore 0.3.0 for a reference reuse', () => {
  assert.deepEqual(referenceReuseSavings(30), { tokens: 57_600, usd: 0.52, basis: 'estimated_blast_radius' });
  assert.deepEqual(referenceReuseSavings(0), { tokens: 72_000, usd: 0.65, basis: 'estimated_default' });
  assert.equal(referenceReuseSavings(10_000).tokens, 240_000);
});

const POOL = { name: 'Redis connection pool tuning', assetId: `sha256:5f1fdc60${'a'.repeat(56)}`, outcome: 'success', tier: 'L1' };
const PASSED = { command: 'npm test', failed: false };

test('a turn nothing was injected into shows nothing', () => {
  assert.equal(turnSummaryOf({ reused: [], lastCheck: PASSED }), null);
});

test('a passing check names the strategy, its asset id, what EvoMap was told and a saving never above the turn\'s spend', () => {
  assert.equal(
    turnSummaryOf({ reused: [POOL], lastCheck: PASSED, changedLines: 30, usage: USAGE }),
    'Evolver · injected "Redis connection pool tuning" (sha256:5f1fdc60) · ✓ last check passed: npm test · reported to EvoMap as success · est. ~6k tokens saved (≈$0.05)',
  );
  const heavy = { input_tokens: 90_000, output_tokens: 10_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  assert.match(turnSummaryOf({ reused: [POOL], lastCheck: PASSED, changedLines: 30, usage: heavy }), /est\. ~58k tokens saved \(≈\$0\.52\)$/);
});

test('a failed check claims no saving and says EvoMap was told it failed', () => {
  assert.equal(
    turnSummaryOf({ reused: [{ ...POOL, outcome: 'failed' }], lastCheck: { command: 'npm test', failed: true }, changedLines: 30, usage: USAGE }),
    'Evolver · injected "Redis connection pool tuning" (sha256:5f1fdc60) · ✗ last check failed: npm test · reported to EvoMap as failed',
  );
});

test('a turn with no check says its use is unverified and that the report carried no evidence, never that a goal was reached', () => {
  const line = turnSummaryOf({ reused: [{ ...POOL, tier: 'none' }], changedLines: 0, usage: USAGE });
  assert.equal(line, 'Evolver · injected "Redis connection pool tuning" (sha256:5f1fdc60) · no check ran, so its use is unverified · reported to EvoMap as success without evidence');
  assert.doesNotMatch(line, /Goal reached|tokens saved|fresh tokens/);
});

test('an unknown last check claims no saving', () => {
  assert.equal(
    turnSummaryOf({ reused: [{ ...POOL, outcome: 'failed', tier: 'none' }], lastCheck: { command: 'npm test', failed: null }, changedLines: 30, usage: USAGE }),
    'Evolver · injected "Redis connection pool tuning" (sha256:5f1fdc60) · ? last check result unknown: npm test · reported to EvoMap as failed without evidence',
  );
});

test('a strategy with no report or asset id is still named, with no claim about what EvoMap was told', () => {
  assert.equal(turnSummaryOf({ reused: [{ name: 'Redis pool' }], lastCheck: PASSED }), 'Evolver · injected "Redis pool" · ✓ last check passed: npm test');
});

test('a Recipe\'s steps are counted and each named', () => {
  const steps = [{ ...POOL, name: 'Unbound redis retries' }, { ...POOL, name: 'Close the redis client', assetId: `sha256:${'b'.repeat(64)}` }];
  assert.match(turnSummaryOf({ reused: steps, lastCheck: PASSED }), /^Evolver · injected 2 strategies: "Unbound redis retries" \(sha256:5f1fdc60\), "Close the redis client" \(sha256:bbbbbbbb\) · /);
});

test('the summary is one line, naming the check by its label, since the desktop notice renders no line breaks', () => {
  const summary = turnSummaryOf({ reused: [POOL], lastCheck: { command: "python3 - <<'EOF'\nassert ok\nEOF", label: 'Check the README edits', failed: false }, changedLines: 10 });
  assert.match(summary, /· ✓ last check passed: Check the README edits ·/);
  assert.doesNotMatch(summary, /\n/);
});

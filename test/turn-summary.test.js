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

test('a turn that reused nothing shows nothing', () => {
  assert.equal(turnSummaryOf({ reusedNames: [], lastCheck: { command: 'npm test', failed: false } }), null);
});

test('a passing check vouches for a saving, never above what the turn spent', () => {
  assert.equal(
    turnSummaryOf({ reusedNames: ['Redis connection pool tuning'], lastCheck: { command: 'npm test', failed: false }, changedLines: 30, usage: USAGE }),
    '✓ Goal reached (last check passed: npm test) · reused EvoMap strategy "Redis connection pool tuning" · est. ~6k tokens saved (≈$0.05) · this turn used 6k fresh tokens',
  );
});

test('a saving under the turn\'s own spend is the estimator\'s figure', () => {
  const heavy = { input_tokens: 90_000, output_tokens: 10_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  assert.match(
    turnSummaryOf({ reusedNames: ['Redis pool'], lastCheck: { command: 'npm test', failed: false }, changedLines: 30, usage: heavy }),
    /est\. ~58k tokens saved \(≈\$0\.52\) · this turn used 100k fresh tokens$/,
  );
});

test('a failed check counts no saving, and the summary leaves the saving out', () => {
  assert.equal(
    turnSummaryOf({ reusedNames: ['Redis pool'], lastCheck: { command: 'npm test', failed: true }, turnReason: 'answer', changedLines: 30, usage: USAGE }),
    '✗ Goal not reached (last check failed: npm test) · reused EvoMap strategy "Redis pool" · this turn used 6k fresh tokens',
  );
});

test('a turn that ran no check and ended normally reached its goal, with no saving claimed', () => {
  assert.equal(
    turnSummaryOf({ reusedNames: ['Redis pool'], turnReason: 'answer', changedLines: 0, usage: USAGE }),
    '✓ Goal reached · reused EvoMap strategy "Redis pool" · this turn used 6k fresh tokens',
  );
});

test('a turn that ran no check and did not end normally says nothing about the goal', () => {
  for (const turnReason of ['aborted', 'error', 'refusal', undefined]) {
    assert.equal(
      turnSummaryOf({ reusedNames: ['Redis pool'], turnReason, usage: USAGE }),
      'reused EvoMap strategy "Redis pool" · this turn used 6k fresh tokens',
      String(turnReason),
    );
  }
});

test('a turn whose usage is unknown counts no saving and states no usage', () => {
  assert.equal(
    turnSummaryOf({ reusedNames: ['Redis pool'], lastCheck: { command: 'npm test', failed: false }, changedLines: 10 }),
    '✓ Goal reached (last check passed: npm test) · reused EvoMap strategy "Redis pool"',
  );
});

test('the summary is one line, since the desktop notice renders no line breaks', () => {
  const summary = turnSummaryOf({ reusedNames: ['Redis pool'], lastCheck: { command: 'npm test', failed: false }, usage: USAGE });
  assert.equal(summary.includes('\n'), false);
});

test('the goal names the check by its label, so a multi-line script never reaches the one-line notice', () => {
  const summary = turnSummaryOf({ reusedNames: ['Redis pool'], lastCheck: { command: "python3 - <<'EOF'\nassert ok\nEOF", label: 'Check the README edits', failed: false }, changedLines: 10 });
  assert.match(summary, /^✓ Goal reached \(last check passed: Check the README edits\) · /);
  assert.doesNotMatch(summary, /\n/);
});

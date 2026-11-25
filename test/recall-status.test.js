import assert from 'node:assert/strict';
import { test } from 'node:test';

import { arrivedLateStatusOf, recallStatusOf, unreportedTurnNoticeOf } from '../lib/recall-status.js';

test('each recall decision has its own status line, led by a mark, injected or not', () => {
  assert.equal(recallStatusOf({ outcome: 'injected', recalled: 2, eligible: 2, name: 'Fix flaky Redis retries' }), '✓ injected "Fix flaky Redis retries"');
  assert.equal(recallStatusOf({ outcome: 'injected', kind: 'recipe', name: 'Redis pipeline', steps: 3 }), '✓ injected Recipe "Redis pipeline" · 3 steps');
  assert.equal(recallStatusOf({ outcome: 'skipped', recalled: 0, eligible: 0 }), '○ no EvoMap strategy fits this prompt');
  assert.equal(recallStatusOf({ outcome: 'skipped', recalled: 2, eligible: 0 }), '○ none injected · Hub returned 2, none relevant or new');
  assert.equal(recallStatusOf({ outcome: 'skipped', recalled: 2, eligible: 1 }), '○ none injected · Hub returned 2, none has enough steps');
  assert.equal(recallStatusOf({ outcome: 'unavailable' }), '! recall skipped · Evolver Proxy did not answer (/evolver-status)');
  assert.equal(recallStatusOf({ outcome: 'short' }), '○ prompt too short to recall for');
});

test('a recall whose trace names no other decision says it injected nothing, and a long name is cut with an ellipsis', () => {
  assert.equal(recallStatusOf(null), '○ no EvoMap strategy injected');
  assert.equal(recallStatusOf({ outcome: 'passed_over' }), '○ no EvoMap strategy injected');
  assert.equal(arrivedLateStatusOf('x'.repeat(80)), `○ "${'x'.repeat(31)}…" arrived after the turn ended, not injected`);
  assert.equal(recallStatusOf({ outcome: 'injected', name: 'y'.repeat(32) }), `✓ injected "${'y'.repeat(32)}"`);
});

test('a turn that reported no strategy ends with what its recall did', () => {
  assert.equal(unreportedTurnNoticeOf({ trace: { outcome: 'skipped', recalled: 0 }, isSettled: true, isJoined: false }), 'Evolver · ○ no EvoMap strategy fits this prompt');
  assert.equal(unreportedTurnNoticeOf({ trace: null, isSettled: false, isJoined: false }), 'Evolver · ! recall had not finished when this turn ended, nothing injected');
  assert.equal(unreportedTurnNoticeOf({ trace: { outcome: 'injected', name: 'Fix retries' }, isSettled: true, isJoined: false }),
    'Evolver · ○ "Fix retries" was recalled after the model\'s last step, so this turn did not use it');
  assert.equal(unreportedTurnNoticeOf({ trace: { outcome: 'injected', name: 'Fix retries' }, isSettled: true, isJoined: true }), 'Evolver · ✓ injected "Fix retries"');
});

test('a turn whose strategy was still being joined says so, neither used nor unused', () => {
  assert.equal(unreportedTurnNoticeOf({ trace: { outcome: 'injected', name: 'Fix retries' }, isSettled: true, isJoined: false, isJoinPending: true }),
    'Evolver · ○ "Fix retries" was still being added when this turn ended');
});

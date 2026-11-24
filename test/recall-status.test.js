import assert from 'node:assert/strict';
import { test } from 'node:test';

import { arrivedLateStatusOf, recallStatusOf } from '../lib/recall-status.js';

test('each recall decision has its own status line, injected or not', () => {
  assert.equal(recallStatusOf({ outcome: 'injected', recalled: 2, eligible: 2, name: 'Fix flaky Redis retries' }), 'evolver · injected "Fix flaky Redis retries" (the Hub returned 2)');
  assert.equal(recallStatusOf({ outcome: 'injected', kind: 'recipe', name: 'Redis pipeline', steps: 3 }), 'evolver · injected Recipe "Redis pipeline" (3 steps)');
  assert.equal(recallStatusOf({ outcome: 'skipped', recalled: 0, eligible: 0 }), 'evolver · no EvoMap strategy fits this prompt');
  assert.equal(recallStatusOf({ outcome: 'skipped', recalled: 2, eligible: 0 }), 'evolver · none injected: the Hub returned 2, none is relevant enough or new to this session');
  assert.equal(recallStatusOf({ outcome: 'skipped', recalled: 2, eligible: 1 }), 'evolver · none injected: the Hub returned 2, none has enough steps to follow');
  assert.equal(recallStatusOf({ outcome: 'unavailable' }), 'evolver · recall skipped: the Evolver Proxy did not answer (/evolver-status)');
  assert.equal(recallStatusOf({ outcome: 'short' }), 'evolver · prompt too short to recall for');
});

test('a recall whose trace names no other decision says it injected nothing, and a long name is cut', () => {
  assert.equal(recallStatusOf(null), 'evolver · no EvoMap strategy injected');
  assert.equal(recallStatusOf({ outcome: 'passed_over' }), 'evolver · no EvoMap strategy injected');
  assert.equal(arrivedLateStatusOf('x'.repeat(80)), `evolver · "${'x'.repeat(48)}" arrived after this turn ended, not injected`);
});

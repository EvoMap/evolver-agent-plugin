import assert from 'node:assert/strict';
import { test } from 'node:test';

import { codexTurnOf } from '../lib/codex/transcript.js';
import { CODEX_CODE_MODE_TURN, CODEX_TURN, line } from './fixtures/codex-turn.mjs';


test('a Codex turn yields its checks in order, its edits and its answer', () => {
  const turn = codexTurnOf(CODEX_TURN);
  assert.deepEqual(turn.checks, [{ command: 'npm test', failed: true }, { command: 'npm test', failed: false }]);
  assert.deepEqual(turn.commands, ['npm test', 'npm test', 'git status']);
  assert.deepEqual(turn.paths, ['/proj', 'lib/redis.js']);
  assert.deepEqual(turn.edits, ['export const retries = null;']);
  assert.equal(turn.changedLines, 2);
  assert.equal(turn.answer, 'Set `maxRetriesPerRequest` to null; npm test passes.');
});

test('failure output without an exit code still fails the check, and junk lines are skipped', () => {
  const turn = codexTurnOf([
    'not json',
    line({ type: 'function_call', name: 'shell', call_id: 'x', arguments: JSON.stringify({ command: 'pytest -q' }) }),
    line({ type: 'function_call_output', call_id: 'x', output: 'FAILED tests/test_a.py::test_b - AssertionError' }),
  ].join('\n'));
  assert.deepEqual(turn.checks, [{ command: 'pytest -q', failed: true }]);
});

test('an empty or missing transcript observes nothing', () => {
  assert.deepEqual(codexTurnOf(''), { checks: [], commands: [], paths: [], edits: [], changedLines: 0, answer: '' });
  assert.deepEqual(codexTurnOf(undefined).checks, []);
});

test('a code-mode turn (Codex 0.144 `exec` scripts) yields the same checks, edits and answer', () => {
  const turn = codexTurnOf(CODEX_CODE_MODE_TURN);
  assert.deepEqual(turn.checks, [{ command: 'npm test', failed: true }, { command: 'npm test', failed: false }]);
  assert.deepEqual(turn.commands, ['npm test', 'git status', 'npm test']);
  assert.deepEqual(turn.paths, ['lib/redis.js']);
  assert.deepEqual(turn.edits, ['export const retries = null;']);
  assert.equal(turn.changedLines, 2);
  assert.equal(turn.answer, 'Set `maxRetriesPerRequest` to null; npm test passes.');
});

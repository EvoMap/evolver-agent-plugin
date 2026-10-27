// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import qoder from '../../../hosts/qoder/profile.js';
import { turnRecordOf } from '../../../lib/turn/record.js';

// Payloads Qoder CLI 1.1.79 sent to a plugin's hooks in print mode (paths renamed), on a turn that ran a failing
// check, edited and wrote files and ran it again, then on a turn of failing commands and a background one.

const PAYLOADS = JSON.parse(readFileSync(new URL('../../fixtures/qoder/hook-payloads.json', import.meta.url), 'utf8'));
const payload = (name) => structuredClone(PAYLOADS[name]);
const noteOf = (name) => qoder.evidence.toolNote(payload(name), { hostEvent: payload(name).hook_event_name });

const SESSION = PAYLOADS['SessionStart.startup'].session_id;
const TURN = PAYLOADS.UserPromptSubmit.request_set_id;
const ONE_SESSION = ['SessionStart.startup', 'UserPromptSubmit', 'PreToolUse.Bash', 'PostToolUseFailure.Bash.exit1', 'PreToolUse.Edit', 'PostToolUse.Edit', 'PostToolUse.Bash.passed', 'Stop', 'SessionEnd'];

test('every event names its session, and a resumed session keeps it', () => {
  for (const name of ONE_SESSION) assert.equal(qoder.payload.sessionId(payload(name)), SESSION, name);
  assert.equal(payload('SessionStart.resume').source, 'resume');
  assert.equal(qoder.payload.sessionId(payload('SessionStart.resume')), SESSION);
});

test('the prompt names its turn by request_set_id, and Stop by parent_request_set_id; tool calls name none', () => {
  assert.equal(qoder.payload.turnId(payload('UserPromptSubmit')), TURN);
  assert.equal(qoder.payload.turnId(payload('Stop')), TURN);
  for (const name of ['SessionStart.startup', 'PreToolUse.Bash', 'PostToolUse.Bash.passed', 'StopFailure', 'SessionEnd']) assert.equal(qoder.payload.turnId(payload(name)), null, name);
});

test('the prompt, the project and the session\'s model are read off the payload', () => {
  assert.equal(qoder.payload.prompt(payload('UserPromptSubmit')), 'fix the readme so the checks pass');
  assert.equal(qoder.payload.projectDir(payload('SessionStart.startup')), '/Users/you/project');
  assert.equal(qoder.payload.projectDir(payload('Stop')), '/Users/you/project');
  assert.equal('model' in payload('Stop'), false, 'Stop names no model');
  assert.deepEqual(qoder.payload.model(payload('Stop')), { model: 'default' }, 'the distillation runs on the person\'s default');
});

test('a subagent\'s event and the task notification Qoder submits for a background command are no turn of the person\'s', () => {
  assert.equal(qoder.payload.isIgnored(payload('UserPromptSubmit')), false);
  assert.equal(qoder.payload.isIgnored(payload('UserPromptSubmit.command')), false);
  assert.equal(qoder.payload.isIgnored(payload('UserPromptSubmit.taskNotification')), true);
  assert.equal(qoder.payload.isIgnored({ ...payload('PostToolUse.Bash.passed'), agent_id: 'a1b2c3d4', agent_type: 'general-purpose' }), true);
});

test('a finished Bash call carries its exit code and output; a failed one its exit code in the error text', () => {
  assert.deepEqual(noteOf('PostToolUse.Bash.passed'), { kind: 'shell', command: 'sh check.sh 2>&1 | tail -5', exit: 0, output: '# tests 1\n# pass 1\n# fail 0' });
  assert.deepEqual(noteOf('PostToolUseFailure.Bash.exit1'), { kind: 'shell', command: 'sh check.sh', exit: 1, output: 'not ok 1 - readme\n# tests 1\n# pass 0\n# fail 1' });
  assert.deepEqual(noteOf('PostToolUseFailure.Bash.exit127'), { kind: 'shell', command: 'npm test', exit: 127, output: '(eval):1: command not found: npm' });
  assert.deepEqual(noteOf('PostToolUseFailure.Bash.timeout'), { kind: 'shell', command: 'sleep 5', exit: 143, output: 'Signal: 15' });
});

test('the same calls running a test suite are a check that failed, then passed; a missing test runner fails it', () => {
  const asSuite = (name) => qoder.evidence.toolNote({ ...payload(name), tool_input: { command: 'node --test' } }, { hostEvent: payload(name).hook_event_name });
  const record = turnRecordOf([asSuite('PostToolUseFailure.Bash.exit1'), noteOf('PostToolUse.Edit'), asSuite('PostToolUse.Bash.passed')]);
  assert.deepEqual(record.checks, [{ command: 'node --test', failed: true }, { command: 'node --test', failed: false }]);
  assert.deepEqual(turnRecordOf([noteOf('PostToolUseFailure.Bash.exit1')]).checks, [], 'sh check.sh is no check the plugin knows');
  assert.deepEqual(turnRecordOf([noteOf('PostToolUseFailure.Bash.exit127')]).checks, [{ command: 'npm test', failed: true }]);
  assert.deepEqual(turnRecordOf([noteOf('PostToolUseFailure.Bash.timeout')]).commands, ['sleep 5']);
});

test('a background command has no verdict when its call returns, and counts as not run', () => {
  const note = noteOf('PostToolUse.Bash.backgrounded');
  assert.deepEqual(note, { kind: 'shell', command: 'sleep 1; echo bg done', running: true, callId: payload('PostToolUse.Bash.backgrounded').tool_use_id });
  assert.deepEqual(turnRecordOf([note]).commands, ['sleep 1; echo bg done']);
});

test('a failure with no exit code ran nothing', () => {
  const denied = { ...payload('PostToolUseFailure.Bash.exit1'), error: 'Permission to use Bash has been denied.' };
  assert.deepEqual(qoder.evidence.toolNote(denied, { hostEvent: 'PostToolUseFailure' }), { kind: 'tool', command: 'sh check.sh' });
});

test('a tool response given as text, as the Qoder IDE documents it, is judged by its output', () => {
  const failing = 'not ok 1 - readme\nAssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n# fail 1\n';
  const asText = { ...payload('PostToolUse.Bash.passed'), tool_input: { command: 'npm test' }, tool_response: failing };
  assert.deepEqual(qoder.evidence.toolNote(asText, { hostEvent: 'PostToolUse' }), { kind: 'shell', command: 'npm test', exit: null, output: failing });
  assert.deepEqual(turnRecordOf([qoder.evidence.toolNote(asText, { hostEvent: 'PostToolUse' })]).checks, [{ command: 'npm test', failed: true }]);
});

test('an Edit or Write that succeeded edits its file, by the lines its input names; one that failed only names it', () => {
  assert.deepEqual(noteOf('PostToolUse.Edit'), { kind: 'edit', paths: ['/Users/you/project/README.md'], lines: 2 });
  assert.deepEqual(noteOf('PostToolUse.Write'), { kind: 'edit', paths: ['/Users/you/project/NOTES.md'], lines: 2 });
  const failed = { ...payload('PostToolUse.Edit'), hook_event_name: 'PostToolUseFailure', error: 'String to replace not found in file.' };
  assert.deepEqual(qoder.evidence.toolNote(failed, { hostEvent: 'PostToolUseFailure' }), { kind: 'tool', paths: ['/Users/you/project/README.md'] });
  assert.deepEqual(turnRecordOf([noteOf('PostToolUse.Edit'), noteOf('PostToolUse.Write')]).edits, ['/Users/you/project/README.md', '/Users/you/project/NOTES.md']);
});

test('the file an edit is about to change is named before it runs; a shell call names none', () => {
  assert.deepEqual(qoder.evidence.editedFiles(payload('PreToolUse.Edit')), ['/Users/you/project/README.md']);
  assert.deepEqual(qoder.evidence.editedFiles(payload('PreToolUse.Write')), ['/Users/you/project/NOTES.md']);
  assert.deepEqual(qoder.evidence.editedFiles(payload('PreToolUse.Bash')), []);
  assert.deepEqual(qoder.evidence.editedFiles({ ...payload('PreToolUse.Edit'), tool_input: { file_path: 'docs/a.md' } }), ['/Users/you/project/docs/a.md']);
  assert.deepEqual(qoder.evidence.editedFiles({ ...payload('PreToolUse.Edit'), tool_input: { file_path: 'docs/a.md' }, cwd: 'relative' }), []);
});

test('Stop ends a turn with its answer, StopFailure as an error, and a turn with neither is aborted at the next prompt', () => {
  assert.equal(qoder.turnEnd.reason(payload('Stop'), { hostEvent: 'Stop' }), 'answer');
  assert.equal(qoder.turnEnd.answer(payload('Stop')), 'Fixed README; checks pass.');
  assert.equal(qoder.turnEnd.reason(payload('StopFailure'), { hostEvent: 'StopFailure' }), 'error');
  assert.equal(qoder.turnEnd.reason(payload('StopFailure')), 'error');
  assert.equal(payload('StopFailure').error, 'authentication_failed');
  assert.equal(qoder.turnEnd.answer(payload('StopFailure')), 'Done with failures.');
  assert.deepEqual(qoder.turnEnd.unclosed, { settleMs: 0, as: 'aborted' });
});

test('QueryEnd names its turn and ends it as aborted on an interrupt or as an error; after Stop it changes nothing', () => {
  assert.equal(qoder.events.QueryEnd, 'turnEnd');
  assert.equal(qoder.payload.turnId(payload('QueryEnd.abort')), payload('QueryEnd.abort').request_set_id);
  assert.equal(qoder.turnEnd.reason(payload('QueryEnd.abort'), { hostEvent: 'QueryEnd' }), 'aborted');
  assert.equal(qoder.turnEnd.reason({ ...payload('QueryEnd.abort'), reason: 'error' }, { hostEvent: 'QueryEnd' }), 'error');
  assert.equal(qoder.turnEnd.reason(payload('QueryEnd.end_turn'), { hostEvent: 'QueryEnd' }), 'unknown', 'Stop already ended it');
  assert.equal(qoder.turnEnd.reason({ ...payload('QueryEnd.end_turn'), reason: 'max_turns' }), 'unknown');
  assert.deepEqual(qoder.reply.turnEnd({ record: { checks: [] }, strategies: ['[Evolution Memory] X (EvoMap network):'] }, 'QueryEnd'), {});
});

test('a strategy rides the prompt as additionalContext; a command blocks the prompt with its answer as the message', () => {
  assert.deepEqual(qoder.reply.context('1. Retry.', 'UserPromptSubmit'), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '1. Retry.' } });
  assert.deepEqual(qoder.reply.context('', 'UserPromptSubmit'), {});
  assert.deepEqual(qoder.reply.notice('[Evolver] Set up.', 'SessionStart'), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '[Evolver] Set up.' } });
  assert.deepEqual(qoder.reply.command({ ok: true, text: 'Evolver Proxy running.' }, 'UserPromptSubmit'), {
    decision: 'block', reason: 'Evolver Proxy running.', systemMessage: 'Evolver Proxy running.',
  });
  for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'SessionEnd']) assert.deepEqual(qoder.reply.empty(event), {}, event);
  assert.deepEqual(qoder.reply.turnEnd({}, 'Stop'), {});
  assert.equal(qoder.reply.lifetime, 'turn');
});

test('the session\'s owner is the hook\'s parent, Qoder CLI itself, and state lives in ~/.evolver/state with nothing to adopt', () => {
  assert.equal(qoder.owner, 'parent');
  assert.match(qoder.stateDir({ HOME: '/h' }), /^[\\/]h[\\/]\.evolver[\\/]state$/);
  assert.deepEqual(qoder.legacy, []);
  assert.equal(qoder.budgets.prompt, 660_000);
});

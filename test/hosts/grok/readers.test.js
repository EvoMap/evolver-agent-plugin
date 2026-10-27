import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { promptCommandOf } from '../../../hosts/grok/commands.js';
import grok from '../../../hosts/grok/profile.js';
import { turnRecordOf } from '../../../lib/turn/record.js';

// Payloads grok 1.0.70 sent to a plugin's hooks on a fake model (paths renamed): one verified turn, a run of other
// tools, a turn cut at --max-turns, a turn whose API call failed, and a typed command.

const PAYLOADS = JSON.parse(readFileSync(new URL('../../fixtures/grok/hook-payloads.json', import.meta.url), 'utf8'));
const payload = (name) => structuredClone(PAYLOADS[name]);
const hostEventOf = (name) => name.split('.')[0];
const noteOf = (name) => grok.evidence.toolNote(payload(name), { hostEvent: hostEventOf(name) });
const reasonOf = (name) => grok.turnEnd.reason(payload(name), { hostEvent: hostEventOf(name) });

const SESSION = '01a17be3-d00d-7890-880c-3ef662ccbfb1';
const PROMPT_ID = 'fa63e6f7-3b05-40a0-9e67-a50e2a22ab25';
const ONE_SESSION = ['SessionStart', 'UserPromptSubmit', 'PreToolUse.run_terminal_command', 'PostToolUse.run_terminal_command.failed', 'PreToolUse.search_replace', 'PostToolUse.search_replace', 'PostToolUse.run_terminal_command.passed', 'Stop', 'Stop.shutdown', 'SessionEnd'];

test('every event names its session; only the prompt and the turn end name the turn, as promptId', () => {
  for (const name of ONE_SESSION) assert.equal(grok.payload.sessionId(payload(name)), SESSION, name);
  assert.equal(grok.payload.turnId(payload('UserPromptSubmit')), PROMPT_ID);
  assert.equal(grok.payload.turnId(payload('Stop')), PROMPT_ID);
  for (const name of ['PreToolUse.search_replace', 'PostToolUse.run_terminal_command.failed', 'SessionStart', 'SessionEnd', 'Stop.shutdown']) {
    assert.equal(grok.payload.turnId(payload(name)), null, name);
  }
  assert.equal(grok.payload.turnId(payload('StopCancelled.max_turns')), payload('StopCancelled.max_turns').promptId);
});

test('the prompt and the project are read off the payload; a subagent\'s event is no turn of the person\'s', () => {
  assert.equal(grok.payload.prompt(payload('UserPromptSubmit')), 'fix the readme so the checks pass');
  assert.equal(grok.payload.projectDir(payload('SessionStart')), '/Users/you/project');
  assert.equal(grok.payload.isIgnored(payload('UserPromptSubmit')), false);
  assert.equal(grok.payload.isIgnored({ ...payload('PostToolUse.search_replace'), subagentType: 'explore' }), true);
  assert.deepEqual(grok.payload.model(payload('Stop')), { model: null }, 'grok names no model; the distillation runs on the default');
});

test('a shell result carries its exit code; failure then pass reads as a fixed check', () => {
  const failed = noteOf('PostToolUse.run_terminal_command.failed');
  assert.deepEqual(failed, { kind: 'shell', command: 'sh check.sh', exit: 1, output: '1 failing: README not fixed\n', callId: 'call_3' });
  assert.deepEqual(noteOf('PostToolUse.run_terminal_command.exit3'), { kind: 'shell', command: 'sleep 1; exit 3', exit: 3, output: '', callId: 'call_18' });
  const record = turnRecordOf([failed, noteOf('PostToolUse.search_replace'), noteOf('PostToolUse.run_terminal_command.passed')]);
  assert.deepEqual(record.commands, ['sh check.sh', 'sh check.sh']);
  assert.deepEqual(record.paths, ['/Users/you/project/README.md']);
});

test('a call grok moves to the background has no verdict until its task\'s output settles it under the same call id', () => {
  const started = noteOf('PostToolUse.run_terminal_command.background');
  assert.deepEqual(started, { kind: 'shell', command: 'sleep 2; npm test', running: true, callId: 'call_3' });
  assert.deepEqual(turnRecordOf([started]).checks, [], 'a check still running is no pass');
  const output = noteOf('PostToolUse.get_command_or_subagent_output');
  assert.deepEqual(output, { kind: 'shell', command: 'sleep 2; npm test', exit: 1, output: '\n> test\n> sh check.sh\n\n1 failing\n', callId: 'call_3' });
  const record = turnRecordOf([noteOf('PostToolUse.run_terminal_command.backgroundForTaskOutput'), output]);
  assert.deepEqual(record.checks, [{ command: 'sleep 2; npm test', failed: true }]);
  assert.deepEqual(record.commands, ['sleep 2; npm test'], 'its output is the same command, not a second one');
  const stillRunning = { ...payload('PostToolUse.get_command_or_subagent_output') };
  stillRunning.toolResult = { ...stillRunning.toolResult, Result: { ...stillRunning.toolResult.Result, status: 'running', exit_code: null } };
  assert.deepEqual(grok.evidence.toolNote(stillRunning), { kind: 'shell', command: 'sleep 2; npm test', running: true, callId: 'call_3' });
});

test('a turn grok starts itself when a background task completes is no turn of the person\'s', () => {
  assert.match(grok.payload.prompt(payload('UserPromptSubmit.taskCompleted')), /^<system-reminder>\nBackground task "call_3" completed \(exit code: 1\)/);
  assert.equal(grok.payload.isIgnored(payload('UserPromptSubmit.taskCompleted')), true);
  assert.equal(grok.payload.isIgnored(payload('Stop.taskCompleted')), true);
  assert.equal(grok.payload.isIgnored({ ...payload('UserPromptSubmit.taskCompleted'), promptId: 'p9' }), true, 'its prompt is only a reminder grok wrote');
  assert.equal(grok.payload.isIgnored({ ...payload('UserPromptSubmit'), prompt: 'fix it\n<system-reminder>x</system-reminder>' }), false);
  assert.equal(grok.payload.isIgnored(payload('Stop.backgroundRunning')), false, 'the person\'s turn that started the task');
});

test('a resumed session starts as a load, under the same session id', () => {
  assert.equal(payload('SessionStart.load').source, 'load');
  assert.equal(grok.payload.sessionId(payload('SessionStart.load')), grok.payload.sessionId(payload('UserPromptSubmit.taskCompleted')));
  assert.equal(grok.events.SessionStart, 'sessionStart');
});

test('an MCP tool that failed is no evidence, but its PostToolUseFailure still carries the strategy', () => {
  assert.equal(grok.evidence.toolNote(payload('PostToolUseFailure.mcp'), { hostEvent: 'PostToolUseFailure' }), null);
  assert.equal(grok.events.PostToolUseFailure, 'toolResult');
  assert.equal(payload('PostToolUseFailure.mcp').error, 'Failed to call fail: boom: the probe tool failed');
});

test('a result past 128 KiB arrives as the model-facing text, whose exit line still decides; a backgrounded call has no verdict', () => {
  const base = payload('PostToolUse.run_terminal_command.failed');
  const truncated = grok.evidence.toolNote({ ...base, toolResult: 'exit: 2\nlots of output', toolResultTruncated: true });
  assert.deepEqual(truncated, { kind: 'shell', command: 'sh check.sh', exit: 2, output: 'lots of output', callId: 'call_3' });
  assert.deepEqual(grok.evidence.toolNote({ ...base, isBackgrounded: true }), { kind: 'shell', command: 'sh check.sh', running: true, callId: 'call_3' });
  assert.equal(grok.evidence.toolNote({ ...base, toolResult: { ...base.toolResult, exit_code: null, timed_out: true } }).exit, 1, 'a timeout failed');
});

test('an applied edit or write is an edit; an edit grok could not make is not, and other tools leave no note', () => {
  assert.deepEqual(noteOf('PostToolUse.search_replace'), { kind: 'edit', paths: ['/Users/you/project/README.md'] });
  assert.deepEqual(noteOf('PostToolUse.write'), { kind: 'edit', paths: [join('/Users/you/project', 'notes.md')] }, 'absolute, as PreToolUse names it');
  assert.deepEqual(grok.evidence.editedFiles(payload('PreToolUse.write')), noteOf('PostToolUse.write').paths);
  assert.deepEqual(noteOf('PostToolUse.search_replace.noMatch'), { kind: 'tool', paths: [join('/Users/you/project', 'README.md')] });
  assert.equal(noteOf('PostToolUse.read_file'), null);
  const cursorPreset = { toolName: 'StrReplace', toolInput: { path: 'src/a.js', old_string: 'a', new_string: 'b' }, toolResult: { ok: true }, cwd: '/Users/you/project' };
  assert.deepEqual(grok.evidence.toolNote(cursorPreset), { kind: 'edit', paths: [join('/Users/you/project', 'src/a.js')] }, 'the Cursor preset names the file in path');
});

test('the file an edit is about to change is named absolute against the event cwd, in either tool shape', () => {
  assert.deepEqual(grok.evidence.editedFiles(payload('PreToolUse.search_replace')), ['/Users/you/project/README.md']);
  assert.deepEqual(grok.evidence.editedFiles(payload('PreToolUse.write')), [join('/Users/you/project', 'notes.md')]);
  assert.deepEqual(grok.evidence.editedFiles({ toolName: 'Write', toolInput: { path: 'b.md', contents: 'x' }, cwd: '/Users/you/project' }), [join('/Users/you/project', 'b.md')]);
  assert.deepEqual(grok.evidence.editedFiles({ toolName: 'EditNotebook', toolInput: { target_notebook: '/n.ipynb' } }), ['/n.ipynb']);
  assert.deepEqual(grok.evidence.editedFiles(payload('PreToolUse.run_terminal_command')), []);
  assert.deepEqual(grok.evidence.editedFiles({ ...payload('PreToolUse.write'), cwd: 'relative' }), []);
});

test('Stop answers, StopFailure errs, StopCancelled aborts; the Stop of a session\'s end ends no turn', () => {
  assert.equal(reasonOf('Stop'), 'answer');
  assert.equal(reasonOf('StopFailure'), 'error');
  assert.equal(reasonOf('StopCancelled.max_turns'), 'aborted');
  assert.equal(reasonOf('Stop.shutdown'), 'unknown');
  assert.equal(grok.turnEnd.answer(payload('Stop')), 'Fixed README; checks pass.');
  assert.deepEqual(grok.turnEnd.unclosed, { settleMs: 2_000, as: 'aborted' });
});

test('the strategy waits for a tool result; a notice and a turn summary go to the person; a command blocks the prompt', () => {
  assert.equal(grok.reply.strategyAt, 'tool-result');
  assert.deepEqual(grok.reply.context('1. Retry.', 'PostToolUse'), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '1. Retry.' } });
  assert.deepEqual(grok.reply.context('1. Retry.', 'PostToolUseFailure'), { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: '1. Retry.' } });
  assert.deepEqual(grok.reply.context('Take a deliberate evolution step', 'UserPromptSubmit'), {}, 'grok would discard it');
  assert.deepEqual(grok.reply.notice('[Evolver] Set up.', 'SessionStart'), { systemMessage: '[Evolver] Set up.' });
  assert.deepEqual(grok.reply.command({ ok: true, text: 'Evolver Proxy running.' }, 'UserPromptSubmit'), { decision: 'block', reason: 'Evolver Proxy running.' });
  assert.deepEqual(grok.reply.turnEnd({}, 'StopCancelled'), {});
  for (const event of ['PreToolUse', 'PostToolUse', 'StopFailure', 'SessionEnd']) assert.deepEqual(grok.reply.empty(event), {}, event);
});

test('a command is the whole prompt, typed with or without a slash or a plugin namespace', () => {
  assert.equal(grok.payload.prompt(payload('UserPromptSubmit.command')), '/evolver-status');
  assert.deepEqual(promptCommandOf('/evolver-status'), { name: 'evolver-status', args: '' });
  assert.deepEqual(promptCommandOf('evolver-search redis retries'), { name: 'evolver-search', args: 'redis retries' });
  assert.deepEqual(promptCommandOf('/evolver-plugin:evolver-evolve the retries'), { name: 'evolver-evolve', args: 'the retries' });
  assert.equal(promptCommandOf('evolver-evolve the retries'), null, 'a command for the agent reaches it only through its command file');
  assert.equal(promptCommandOf('evolver-status please'), null, 'a command that takes no argument followed by text is a prompt');
  assert.equal(promptCommandOf('evolver-statusline'), null);
  assert.equal(promptCommandOf('fix the evolver-status command'), null);
  assert.equal(grok.commands.entry, 'intercept');
  assert.equal(grok.commands.answerReachesModel, false, 'a blocked prompt reaches no model');
});

test('the plugin sees grok\'s plugin variables; state lives in ~/.evolver/state, and nothing is adopted', () => {
  const env = PAYLOADS['env.PostToolUse'];
  assert.match(env.GROK_PLUGIN_ROOT, /\/\.grok\/installed-plugins\//);
  assert.equal(env.CLAUDE_PLUGIN_ROOT, env.GROK_PLUGIN_ROOT);
  assert.equal(env.GROK_HOOK_EVENT, 'post_tool_use');
  assert.match(grok.stateDir({ HOME: '/h' }), /^[\\/]h[\\/]\.evolver[\\/]state$/);
  assert.equal(grok.budgets.sessionEnd, 1_500, 'grok gives a plugin\'s SessionEnd hook 1.5 s');
  assert.deepEqual(grok.legacy, []);
  assert.equal(grok.owner, 'parent', 'the hook\'s parent is the grok process, past any sh -c');
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { patchedPaths } from '../../../hosts/codex/evidence.js';
import codex from '../../../hosts/codex/profile.js';
import { turnRecordOf } from '../../../lib/turn/record.js';

// Payloads Codex 0.164.0 sent to a plugin's hooks (paths renamed), and the tool responses of the standalone
// plugin's tests, from Codex 0.144.

const fixture = (name) => readFileSync(new URL(`../../fixtures/codex/${name}`, import.meta.url), 'utf8');
const PAYLOADS = JSON.parse(fixture('hook-payloads.json'));
const RESPONSES_0144 = JSON.parse(fixture('tool-responses-0.144.json'));
const payload = (name) => structuredClone(PAYLOADS[name]);
const noteOf = (name) => codex.evidence.toolNote(payload(name));
const bash = (response, { command = 'npm test', callId = 'call_suite' } = {}) =>
  codex.evidence.toolNote({ ...payload('PostToolUse.Bash.passed'), tool_input: { command }, tool_response: response, tool_use_id: callId });
const checksOf = (...notes) => turnRecordOf(notes).checks;

const SESSION = '01a17b33-1759-7171-b4c0-2618b2cbe40e';
const TURN = '01a17b33-17ae-7f93-a0ea-d7608791f4bd';

const ONE_SESSION = ['SessionStart.startup', 'UserPromptSubmit', 'PreToolUse.apply_patch', 'PostToolUse.apply_patch', 'PreToolUse.Bash', 'PostToolUse.Bash.passed', 'PostToolUse.Bash.exit3', 'Stop', 'SessionEnd'];

test('every event names its session; the prompt, its tool calls and the turn end name the turn', () => {
  for (const name of ONE_SESSION) assert.equal(codex.payload.sessionId(payload(name)), SESSION, name);
  for (const name of ['UserPromptSubmit', 'PreToolUse.apply_patch', 'PostToolUse.apply_patch', 'PostToolUse.Bash.passed', 'Stop']) {
    assert.equal(codex.payload.turnId(payload(name)), TURN, name);
  }
  assert.equal(codex.payload.turnId(payload('SessionStart.startup')), null);
  assert.equal(codex.payload.turnId(payload('SessionEnd')), null, 'SessionEnd names no turn');
  assert.equal(codex.payload.turnId(payload('Interrupt')), payload('Interrupt').turn_id);
});

test('a resumed thread keeps its session id, so its turn counter carries on', () => {
  assert.equal(payload('SessionStart.resume').source, 'resume');
  assert.equal(codex.payload.sessionId(payload('SessionStart.resume')), codex.payload.sessionId(payload('Interrupt')));
});

test('the prompt, the project and the model the distillation runs on are read off the payload', () => {
  assert.equal(codex.payload.prompt(payload('UserPromptSubmit')), 'Write add.mjs with a test and run node --test.');
  assert.equal(codex.payload.projectDir(payload('SessionStart.startup')), '/Users/dev/project');
  assert.deepEqual(codex.payload.model(payload('Stop')), { model: 'gpt-5.5' });
  assert.equal(codex.payload.model(payload('SessionEnd')), null, 'SessionEnd names no model');
  assert.equal(codex.payload.isIgnored(payload('UserPromptSubmit')), false);
  assert.equal(codex.payload.isIgnored({ ...payload('UserPromptSubmit'), agent_id: 'sub-1' }), true, 'a subagent gets no recall');
});

test('an apply_patch result edits the files its patch names once Codex says it applied', () => {
  assert.deepEqual(noteOf('PostToolUse.apply_patch'), { kind: 'edit', paths: ['add.mjs', 'add.test.mjs'] });
  assert.deepEqual(
    codex.evidence.toolNote({ ...payload('PostToolUse.apply_patch'), tool_response: RESPONSES_0144['apply_patch.failed'] }),
    { kind: 'tool', paths: ['add.mjs', 'add.test.mjs'] },
  );
  assert.deepEqual(patchedPaths(RESPONSES_0144['patch.everyHeader']), ['src/lru.js', 'src/old.js', 'src/new.js', 'src/gone.js']);
});

test('a Bash result carries no exit code, so a check is judged by its output', () => {
  const passed = noteOf('PostToolUse.Bash.passed');
  assert.deepEqual({ ...passed, output: undefined }, { kind: 'shell', command: 'node --test', exit: null, output: undefined, callId: 'call_4' });
  assert.deepEqual(checksOf(passed), [{ command: 'node --test', failed: false }]);
  assert.deepEqual(noteOf('PostToolUse.Bash.exit3'), { kind: 'shell', command: 'node -e "console.log(\'boom\'); process.exit(3)"', exit: null, output: 'boom\n', callId: 'call_6' });
  assert.deepEqual(checksOf(bash('boom\n')), [{ command: 'npm test', failed: false }], 'a check that fails silently reads as passed');
  assert.deepEqual(checksOf(bash(RESPONSES_0144['bash.patchAndFailingTests'])), [{ command: 'npm test', failed: true }]);
});

test('a command that ran past its wait limit reaches the hook once it ended, with its whole output', () => {
  assert.deepEqual(checksOf(noteOf('PostToolUse.Bash.waited')), [{ command: 'sleep 2; node --test', failed: false }]);
});

test('an exit-code header decides, a timeout fails, and a run still going waits for its completion', () => {
  assert.deepEqual(bash(RESPONSES_0144['bash.exitHeaderFailed']), { kind: 'shell', command: 'npm test', exit: 1, output: 'Output:\nall good', callId: 'call_suite' });
  assert.deepEqual(checksOf(bash(RESPONSES_0144['bash.exitHeaderPassed'])), [{ command: 'npm test', failed: false }]);
  assert.deepEqual(checksOf(bash(RESPONSES_0144['bash.timedOut'])), [{ command: 'npm test', failed: true }]);
  const running = bash(RESPONSES_0144['bash.stillRunning']);
  assert.deepEqual(running, { kind: 'shell', command: 'npm test', running: true, callId: 'call_suite' });
  assert.deepEqual(turnRecordOf([running]).checks, [], 'a run with no verdict counts as not run');
  const completed = turnRecordOf([running, bash(RESPONSES_0144['bash.finishedFailing'])]);
  assert.deepEqual(completed.checks, [{ command: 'npm test', failed: true }]);
  assert.deepEqual(completed.commands, ['npm test'], 'its completion is the same command');
  assert.deepEqual(checksOf(running, bash(RESPONSES_0144['bash.finishedExited'])), [{ command: 'npm test', failed: true }]);
});

test('a patch a Bash command applies is an edit; beside a check in the same command, the check', () => {
  const patch = RESPONSES_0144['patch.everyHeader'];
  const applying = `apply_patch <<'PATCH'\n${patch}\nPATCH`;
  assert.deepEqual(bash(RESPONSES_0144['bash.patchAndPassingTests'], { command: applying }), {
    kind: 'edit', command: applying, paths: ['src/lru.js', 'src/old.js', 'src/new.js', 'src/gone.js'],
  });
  const checked = turnRecordOf([bash(RESPONSES_0144['bash.patchAndFailingTests'], { command: `${applying}\nnode --test` })]);
  assert.deepEqual(checked.checks, [{ command: `${applying}\nnode --test`.slice(0, 200), failed: true }]);
  assert.ok(checked.paths.includes('src/new.js'));
});

test('the files a patch is about to change are named absolute against the session cwd', () => {
  assert.deepEqual(codex.evidence.editedFiles(payload('PreToolUse.apply_patch')), [join('/Users/dev/project', 'add.mjs'), join('/Users/dev/project', 'add.test.mjs')]);
  assert.deepEqual(codex.evidence.editedFiles(payload('PreToolUse.Bash.applyPatchHeredoc')), [join('/Users/dev/project', 'add.mjs')], 'Codex 0.164 runs no PostToolUse for it');
  assert.deepEqual(codex.evidence.editedFiles(payload('PreToolUse.apply_patch.missingFile')), [join('/Users/dev/project', 'missing.mjs')]);
  assert.deepEqual(codex.evidence.editedFiles(payload('PreToolUse.Bash')), []);
  assert.deepEqual(codex.evidence.editedFiles({ ...payload('PreToolUse.apply_patch'), cwd: 'relative' }), []);
});

test('Stop ends a turn with its answer, Interrupt aborts it, and a turn with neither ends as an error at the next prompt', () => {
  assert.equal(codex.turnEnd.reason(payload('Stop'), { hostEvent: 'Stop' }), 'answer');
  assert.equal(codex.turnEnd.reason(payload('Interrupt'), { hostEvent: 'Interrupt' }), 'aborted');
  assert.equal(codex.turnEnd.reason(payload('Interrupt')), 'aborted');
  assert.equal(codex.turnEnd.answer(payload('Stop')), 'add works: node --test passed 1 test.');
  assert.equal(payload('Stop').stop_hook_active, false);
  assert.deepEqual(codex.turnEnd.unclosed, { settleMs: 0, as: 'error' });
});

test('a strategy rides the prompt as additionalContext; a command blocks the prompt with its answer; Stop and Interrupt get {}', () => {
  assert.deepEqual(codex.reply.context('1. Retry.', 'UserPromptSubmit'), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '1. Retry.' } });
  assert.deepEqual(codex.reply.context('', 'UserPromptSubmit'), {});
  assert.deepEqual(codex.reply.notice('[Evolver] Set up.', 'SessionStart'), { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '[Evolver] Set up.' } });
  assert.deepEqual(codex.reply.command({ ok: true, text: 'Evolver Proxy running.' }, 'UserPromptSubmit'), { decision: 'block', reason: 'Evolver Proxy running.' });
  for (const event of ['PreToolUse', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd']) assert.deepEqual(codex.reply.empty(event), {}, event);
  assert.deepEqual(codex.reply.turnEnd({}, 'Stop'), {});
  assert.equal(codex.reply.lifetime, 'turn');
});

test('state lives in ~/.evolver/state, where the standalone plugin left its codex-* files, and its ledgers are adopted', () => {
  assert.match(codex.stateDir({ HOME: '/h' }), /^[\\/]h[\\/]\.evolver[\\/]state$/);
  assert.deepEqual(codex.legacy, [{ ledgers: /^codex-injected-[0-9a-f]{16}\.json$/ }]);
});

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

import cursor from '../../../hosts/cursor/profile.js';
import { modelRunnerOf } from '../../../lib/runtime/model-executor.js';
import { ownerProbeOf } from '../../../lib/runtime/process/owner.js';
import { turnRecordOf } from '../../../lib/turn/record.js';

const PAYLOADS = JSON.parse(readFileSync(new URL('../../fixtures/cursor/payloads.json', import.meta.url), 'utf8'));
const payload = (name) => structuredClone(PAYLOADS[name]);
const noteOf = (name) => cursor.evidence.toolNote(payload(name));

test('the session is the conversation, the turn its generation, the project the first workspace root', () => {
  const prompt = payload('beforeSubmitPrompt');
  assert.equal(cursor.payload.sessionId(prompt), 'c-1');
  assert.equal(cursor.payload.turnId(prompt), 'g-1');
  assert.equal(cursor.payload.prompt(prompt), 'fix the flaky redis connection retries in our tests');
  assert.equal(cursor.payload.projectDir(prompt), '/work/app');
  assert.equal(cursor.payload.turnId(payload('sessionStart')), null, 'sessionStart sends an empty generation');
  assert.equal(cursor.payload.sessionId({ session_id: 'only-session' }), 'only-session');
});

test('only the agent chat counts: an inline edit names no composer_mode and is left alone', () => {
  assert.equal(cursor.payload.isIgnored(payload('beforeSubmitPrompt')), false);
  assert.equal(cursor.payload.isIgnored(payload('beforeSubmitPrompt.inlineEdit')), true);
  assert.equal(cursor.payload.isIgnored(payload('postToolUse.shellPassed')), false, 'a tool event names no composer_mode either');
});

test('the chat model is kept as Cursor names it; an empty name is the default', () => {
  assert.deepEqual(cursor.payload.model(payload('stop.completed')), { model: 'claude-4.5-sonnet' });
  assert.deepEqual(cursor.payload.model(payload('stop.defaultModel')), { model: 'default' });
});

test('a Shell result is a check by its exit code and output; writes, deletes and edits are noted by path', () => {
  assert.deepEqual(noteOf('postToolUse.shellPassed'), { kind: 'shell', command: 'npm test', exit: 0, output: 'ℹ tests 2\nℹ pass 2\nℹ fail 0\n' });
  assert.deepEqual(noteOf('postToolUse.shellFailed'), { kind: 'shell', command: 'npm test', exit: 1, output: 'done' });
  assert.deepEqual(noteOf('postToolUse.write'), { kind: 'tool', paths: ['/work/app/lib/redis.js'] });
  assert.deepEqual(noteOf('postToolUse.delete'), { kind: 'edit', paths: ['/work/app/lib/old.js'] });
  assert.deepEqual(noteOf('afterFileEdit'), { kind: 'edit', paths: ['/work/app/lib/redis.js'] });
});

test('a failed Shell call fails its check on an exit or a timeout; an interrupt or a backgrounded run has no verdict, a denial never ran', () => {
  assert.deepEqual(noteOf('postToolUseFailure.exit'), { kind: 'shell', command: 'npm test', exit: 1, output: 'not ok 1 - retries\nAssertionError: expected 1 to equal 2' });
  assert.equal(noteOf('postToolUseFailure.timeout').exit, 1);
  assert.deepEqual(noteOf('postToolUseFailure.interrupted'), { kind: 'tool', command: 'npm test', paths: [] });
  assert.deepEqual(noteOf('postToolUseFailure.backgrounded'), { kind: 'tool', command: 'npm test', paths: [] });
  assert.equal(noteOf('postToolUseFailure.denied'), null);
  const record = turnRecordOf(['postToolUseFailure.exit', 'postToolUseFailure.interrupted', 'postToolUse.shellPassed'].map(noteOf));
  assert.deepEqual(record.checks, [{ command: 'npm test', failed: true }, { command: 'npm test', failed: false }]);
});

test('the final answer of afterAgentResponse travels as a note of its own', () => {
  assert.deepEqual(noteOf('afterAgentResponse'), { kind: 'answer', text: 'Retries fixed; npm test passes.' });
  assert.equal(cursor.evidence.toolNote({ ...payload('afterAgentResponse'), text: '  ' }), null);
});

test('the file an edit is about to change is named absolute, from a Write or a Delete only', () => {
  assert.equal(cursor.evidence.editedFile(payload('preToolUse.write')), '/work/app/lib/redis.js');
  assert.equal(cursor.evidence.editedFile(payload('preToolUse.relative')), join('/work/app', 'lib/old.js'));
  assert.equal(cursor.evidence.editedFile({ ...payload('preToolUse.write'), tool_name: 'Shell' }), null);
});

test('each stop status is the turn-end reason', () => {
  const reasonOf = (status) => cursor.turnEnd.reason({ ...payload('stop.completed'), status });
  assert.deepEqual(['completed', 'aborted', 'error', 'unexpected'].map(reasonOf), ['answer', 'aborted', 'error', 'error']);
  assert.deepEqual(cursor.turnEnd.unclosed, { settleMs: 3_000, as: 'error' });
});

test('context rides the prompt with continue; a command stops the prompt with its answer, except one meant for the agent', () => {
  assert.deepEqual(cursor.reply.context('1. Retry.'), { continue: true, additional_context: '1. Retry.' });
  assert.deepEqual(cursor.reply.context(''), {});
  assert.deepEqual(cursor.reply.notice('[Evolver] Set up.'), { additional_context: '[Evolver] Set up.' });
  assert.deepEqual(cursor.reply.command({ ok: true, text: 'status' }), { continue: false, user_message: 'status' });
  assert.deepEqual(cursor.reply.command({ ok: true, text: 'Reflect.', forAgent: true }), { continue: true, additional_context: 'Reflect.' });
  assert.deepEqual(cursor.reply.turnEnd({}), {}, 'a stop answer with a followup_message would start another turn');
});

test('the owner is the nearest ancestor named Cursor, past the shell the extension host runs the hook in', () => {
  const table = new Map([
    [process.ppid, { ppid: 700, name: 'node' }],
    [700, { ppid: 600, name: 'zsh' }],
    [600, { ppid: 500, name: 'Cursor Helper (Plugin)' }],
    [500, { ppid: 1, name: 'Cursor' }],
  ]);
  assert.equal(ownerProbeOf(cursor.owner, { probe: (pid) => table.get(pid) ?? null, platform: 'darwin' }).current(), 600);
});

test('under the CLI the owner is the cursor-agent process, whose executable is a node inside its install', () => {
  const table = new Map([
    [process.ppid, { ppid: 900, name: 'bash' }],
    [900, { ppid: 1, name: 'node', path: '/Users/me/.local/share/cursor-agent/versions/2026.10.20/node' }],
  ]);
  assert.equal(ownerProbeOf(cursor.owner, { probe: (pid) => table.get(pid) ?? null, platform: 'darwin' }).current(), 900);
});

test('the headless model is cursor-agent in print and ask mode on the chat model, read from its JSON result', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'evolver-cursor-bin-'));
  try {
    const log = join(bin, 'calls.jsonl');
    const fake = join(bin, 'cursor-agent');
    writeFileSync(fake, [
      `#!${process.execPath}`,
      "const { appendFileSync } = require('node:fs');",
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; }).on('end', () => {",
      `  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), input, headless: process.env.EVOLVER_HEADLESS }) + '\\n');`,
      "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{\"summary\":\"s\"}', session_id: 'x' }));",
      '});',
    ].join('\n'));
    chmodSync(fake, 0o755);
    const runner = modelRunnerOf(cursor.model, { ...process.env, PATH: [bin, process.env.PATH].join(delimiter) });
    assert.deepEqual(await runner.complete({ model: 'gpt-5' }, 'PROMPT', AbortSignal.timeout(10_000)), { answer: '{"summary":"s"}', usage: null });
    await runner.complete({ model: 'default' }, 'PROMPT', AbortSignal.timeout(10_000));
    const [named, unnamed] = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(named.args.slice(0, 7), ['-p', '--output-format', 'json', '--mode', 'ask', '--trust', '--workspace']);
    assert.match(named.args[7], /hosts[/\\]cursor[/\\]dist$/);
    assert.deepEqual(named.args.slice(8), ['--model', 'gpt-5']);
    assert.equal(named.args.includes('--force'), false);
    assert.equal(unnamed.args.includes('--model'), false);
    assert.equal(named.input, 'PROMPT');
    assert.equal(named.headless, '1');
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test('a cursor-agent run that answers no result object fails with what it printed', () => {
  assert.throws(() => cursor.model.parse({ stdout: '{"type":"result","is_error":true,"result":"x"}', stderr: '' }), /cursor-agent gave no answer/);
  assert.throws(() => cursor.model.parse({ stdout: '', stderr: 'Authentication required' }), /Authentication required/);
});

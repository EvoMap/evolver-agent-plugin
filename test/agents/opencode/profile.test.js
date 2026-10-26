import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import profile from '../../../agents/opencode/profile.js';
import { createTurnTracker } from '../../../agents/opencode/dist/turns.js';
import { turnRecordOf } from '../../../lib/turn/record.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../../fixtures/opencode/payloads.json', import.meta.url), 'utf8'));
const { bash, args, assistant, errors, sessions } = FIXTURE;
const note = (payload) => profile.evidence.toolNote(payload);
const checksOf = (...results) => turnRecordOf(results.map((result) => note({ tool: 'bash', args: { command: result.title }, result }))).checks;

test('the prompt is what the person typed, without the synthetic text OpenCode adds for an attached file', () => {
  assert.equal(profile.payload.prompt(FIXTURE.chatMessage.output), 'add a retry to the uploader');
  assert.equal(profile.payload.sessionId({ sessionID: 'ses_a' }), 'ses_a');
  assert.equal(profile.payload.turnId({ turnID: 'msg_0001' }), 'msg_0001');
});

test('only the person\'s own sessions count: a task tool\'s child and the distillation helper are skipped', () => {
  assert.equal(profile.payload.isSubagent({ session: sessions.person }), false);
  assert.equal(profile.payload.isSubagent({ session: null }), false);
  assert.equal(profile.payload.isSubagent({ session: sessions.subagent }), true);
  assert.equal(profile.payload.isSubagent({ session: sessions.helper }), true);
});

test('a bash check passes or fails on its exit code, and on failure output a `| tail` hid from it', () => {
  assert.deepEqual(checksOf(bash.passed, bash.failed, bash.failedThroughTail).map((check) => check.failed), [false, true, true]);
});

test('a check the person interrupted gives no verdict, while one its timeout killed failed', () => {
  assert.deepEqual(checksOf(bash.interrupted), []);
  assert.deepEqual(checksOf(bash.timedOut), [{ command: 'npm test', failed: true }]);
  const record = turnRecordOf([note({ tool: 'bash', args: { command: 'npm test' }, result: bash.interrupted })]);
  assert.deepEqual(record.commands, ['npm test']);
});

test('a command that is no check keeps its exit code but not its output', () => {
  assert.deepEqual(note({ tool: 'bash', args: { command: 'ls' }, result: bash.listing }), { kind: 'shell', command: 'ls', exit: 0 });
});

test('edit, write and apply_patch are edits of every file they touch; a read names its file', () => {
  assert.deepEqual(note({ tool: 'edit', args: args.edit }), { kind: 'edit', paths: ['src/upload.js'] });
  assert.deepEqual(note({ tool: 'write', args: args.write }), { kind: 'edit', paths: ['/proj/src/retry.js'] });
  assert.deepEqual(note({ tool: 'apply_patch', args: args.applyPatch }), { kind: 'edit', paths: ['src/upload.js', 'src/retry.js'] });
  assert.deepEqual(note({ tool: 'read', args: args.read }), { kind: 'tool', paths: ['/proj/README.md'] });
  assert.equal(note({ tool: 'todowrite', args: { todos: [] } }), null);
});

test('the file an edit is about to change is resolved against the project; other tools change none', () => {
  assert.equal(profile.evidence.editedFile({ tool: 'edit', args: args.edit, directory: '/proj' }), '/proj/src/upload.js');
  assert.equal(profile.evidence.editedFile({ tool: 'apply_patch', args: args.applyPatch, directory: '/proj' }), '/proj/src/upload.js');
  assert.equal(profile.evidence.editedFile({ tool: 'read', args: args.read, directory: '/proj' }), null);
});

test('a turn ends as answer, aborted or error, read off its session error and last assistant message', () => {
  const reason = (end) => profile.turnEnd.reason(end);
  assert.equal(reason({ lastAssistant: assistant.completed }), 'answer');
  assert.equal(reason({ lastAssistant: assistant.aborted }), 'aborted');
  assert.equal(reason({ error: errors.aborted, lastAssistant: assistant.completed }), 'aborted');
  assert.equal(reason({ error: errors.api, lastAssistant: assistant.completed }), 'error');
  assert.equal(reason({ lastAssistant: assistant.length }), 'error');
  assert.equal(reason({ lastAssistant: assistant.toolCalls }), 'error');
  assert.equal(reason({ lastAssistant: null }), 'aborted');
  assert.deepEqual(profile.payload.model({ lastAssistant: assistant.completed }), { providerID: 'anthropic', modelID: 'claude-sonnet' });
});

test('an error a compaction recovered from no longer ends the turn as an error', () => {
  const turns = createTurnTracker();
  turns.open('ses_a', 'msg_0001');
  turns.noteAssistant('ses_a', { ...assistant.completed, id: 'msg_a1', finish: undefined });
  turns.noteError('ses_a', { name: 'ContextOverflowError', data: {} });
  turns.noteAssistant('ses_a', { ...assistant.completed, id: 'msg_a2' });
  turns.noteText('ses_a', 'msg_a2', 'Added the retry.');
  const ended = turns.close('ses_a');
  assert.equal(profile.turnEnd.reason(ended), 'answer');
  assert.equal(profile.turnEnd.answer(ended), 'Added the retry.');
  assert.equal(turns.close('ses_a'), null);
});

test('the strategy answers as a synthetic text part, a notice as a toast, a searched strategy joins the conversation', () => {
  assert.deepEqual(profile.reply.context('1. Retry.'), { part: { type: 'text', text: '1. Retry.', synthetic: true } });
  assert.deepEqual(profile.reply.context(''), {});
  assert.deepEqual(profile.reply.notice('[Evolver] started'), { toast: '[Evolver] started' });
  assert.deepEqual(profile.reply.command({ ok: true, text: 'ran' }, 'tui.command', { command: 'evolver-status' }), { ok: true, text: 'ran' });
  assert.equal(profile.reply.command({ ok: true, text: '1. Retry.' }, 'tui.command', { command: 'evolver-search' }).part.synthetic, true);
  assert.equal(profile.reply.command({ ok: false, text: 'none' }, 'tui.command', { command: 'evolver-search' }).part, undefined);
});

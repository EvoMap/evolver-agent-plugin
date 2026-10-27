import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { answerTextOf, modelOf, personTextOf } from '../../../hosts/dsh/messages.js';
import profile from '../../../hosts/dsh/profile.js';
import { editedFilesOf, toolNoteOf } from '../../../hosts/dsh/tools.js';
import { turnEndReason } from '../../../hosts/dsh/turn-end.js';

const DSH = JSON.parse(readFileSync(new URL('../../fixtures/dsh/payloads.json', import.meta.url), 'utf8'));
const PROJECT = '/home/dev/project';
const contextOf = (hostEvent) => ({ hostEvent });

test('the person\'s prompt is the text of the step\'s user messages, never the runtime context or a plugin\'s note', () => {
  assert.equal(personTextOf(DSH.preStep.prompt.messages), 'add a sum function to sum.js and make the tests pass');
  assert.equal(personTextOf(DSH.preStep.resumedPrompt.messages), 'now explain what sum does');
  assert.equal(personTextOf(DSH.preStep.lateNoteNextStep.messages), '');
  assert.equal(personTextOf(DSH.preStep.evolveFollowup.messages), '');
  assert.equal(personTextOf(DSH.preStep.toolStep.messages), '');
});

test('a turn another producer opened, and anything of a subagent, is no turn of the person\'s', () => {
  const { isIgnored } = profile.payload;
  const step = (messages, extra = {}) => ({ sessionId: DSH.agentCreated.startup.sessionId, turn: 1, messages, ...extra });
  assert.equal(isIgnored(step(DSH.preStep.prompt.messages), contextOf('agent/pre-step')), false);
  assert.equal(isIgnored(step(DSH.preStep.evolveFollowup.messages), contextOf('agent/pre-step')), true);
  assert.equal(isIgnored(step(DSH.preStep.evolveFollowup.messages, { command: 'evolver-evolve' }), contextOf('agent/pre-step')), false);
  assert.equal(isIgnored(step(DSH.subagent.prompt.messages, { origin: DSH.agentCreated.subagent.header.origin }), contextOf('agent/pre-step')), true);
  assert.equal(isIgnored({ origin: DSH.subagent.disposedHeader.origin }, contextOf('session/disposed')), true);
  assert.equal(isIgnored({ origin: null }, contextOf('tools/execute')), false);
});

test('session, turn and project come from the session the entry raised the event for', () => {
  const payload = { sessionId: DSH.agentCreated.resume.sessionId, cwd: DSH.agentCreated.resume.header.cwd, turn: DSH.preStep.resumedPrompt.turn };
  assert.equal(profile.payload.sessionId(payload), 'session-1f2aef5c-50fd-4441-aa5d-7e8bcf695969');
  assert.equal(profile.payload.turnId(payload), '2', 'a resumed session goes on counting dsh turns');
  assert.equal(profile.payload.projectDir(payload), PROJECT);
  assert.equal(profile.payload.turnId({ sessionId: 's' }), null);
});

test('the answer and the model are read off the turn\'s last assistant message', () => {
  assert.equal(answerTextOf(DSH.assistantMessage.answer.message), 'Added sum; the tests pass.');
  assert.equal(answerTextOf(DSH.assistantMessage.toolCall.message), '');
  assert.deepEqual(modelOf(DSH.assistantMessage.answer.message), { provider: 'deepseek-official', model: 'deepseek-flash' });
  assert.deepEqual(profile.payload.model({ lastAssistant: DSH.assistantMessage.answer.message }), { provider: 'deepseek-official', model: 'deepseek-flash' });
  assert.equal(modelOf(null), null);
});

test('a shell check takes the exit code dsh reports, and its output when it is a check', () => {
  assert.deepEqual(toolNoteOf(DSH.tools.bashPassed), { kind: 'shell', command: 'npm test 2>&1 | tail -5', exit: 0, output: DSH.tools.bashPassed.result.content[0].text });
  assert.deepEqual(toolNoteOf(DSH.tools.bashExit3), { kind: 'shell', command: 'node -e "process.exit(3)"', exit: 3 });
});

test('a command still running in the background, or one dsh refused, has no verdict', () => {
  assert.deepEqual(toolNoteOf(DSH.tools.bashBackground), { kind: 'shell', command: 'sleep 1; echo background done', running: true });
  assert.deepEqual(toolNoteOf(DSH.tools.bashPromoted), { kind: 'shell', command: 'sleep 3; echo slow', running: true });
  assert.deepEqual(toolNoteOf(DSH.tools.bashRefused), { kind: 'shell', command: 'exit 0', running: true });
});

test('a run without dsh 0.2\'s structured value is read off the markers its text ends with', () => {
  const run = (text, extra = {}) => toolNoteOf({ name: 'bash', arguments: { command: 'npm test' }, result: { isError: false, content: [{ type: 'text', text }], ...extra } });
  assert.equal(run('ℹ fail 1\n[exit code: 1]').exit, 1);
  assert.equal(run('ℹ pass 4').exit, 0);
  assert.equal(run('partial\n[timed out after 60000ms]\n[killed by signal: SIGTERM]').exit, 124);
  assert.equal(run('done', { value: 'ok\n[Command finished with exit code 2]' }).exit, 2);
  const killed = { ...DSH.tools.bashExit3, result: { ...DSH.tools.bashExit3.result, value: { ...DSH.tools.bashExit3.result.value, exitCode: null, signal: 'SIGKILL' } } };
  assert.equal(toolNoteOf(killed).exit, 124);
});

test('write and edit are edits; a read names the file it read', () => {
  assert.deepEqual(toolNoteOf(DSH.tools.write), { kind: 'edit', paths: ['sum.js'] });
  assert.deepEqual(toolNoteOf(DSH.tools.edit), { kind: 'edit', paths: ['sum.js'] });
  assert.deepEqual(toolNoteOf(DSH.tools.read), { kind: 'tool', paths: ['sum.js'] });
  const failed = { ...DSH.tools.edit, result: { isError: true, content: [{ type: 'text', text: 'old_string not found' }] } };
  assert.deepEqual(toolNoteOf(failed), { kind: 'tool', paths: ['sum.js'] });
  assert.equal(toolNoteOf({ name: 'todo_write', arguments: { todos: [] }, result: { isError: false, content: [] } }), null);
  assert.deepEqual(toolNoteOf({ name: 'str_replace_editor', arguments: { command: 'view', path: 'a.js' } }), { kind: 'tool', paths: ['a.js'] });
  assert.deepEqual(toolNoteOf({ name: 'str_replace_editor', arguments: { command: 'str_replace', path: 'a.js' }, result: { isError: false } }), { kind: 'edit', paths: ['a.js'] });
});

test('the files an edit is about to change are resolved against the session\'s folder', () => {
  assert.deepEqual(editedFilesOf({ ...DSH.tools.write, cwd: PROJECT }), [`${PROJECT}/sum.js`]);
  assert.deepEqual(editedFilesOf({ ...DSH.tools.edit, cwd: PROJECT }), [`${PROJECT}/sum.js`]);
  assert.deepEqual(editedFilesOf({ ...DSH.tools.read, cwd: PROJECT }), []);
  assert.deepEqual(editedFilesOf({ ...DSH.tools.write, cwd: null }), []);
});

test('how a turn ended, from turn/end\'s reason', () => {
  assert.equal(turnEndReason(DSH.turnEnd.completed), 'answer');
  assert.equal(turnEndReason(DSH.turnEnd.error), 'error');
  assert.equal(turnEndReason({ reason: { kind: 'aborted', reason: { kind: 'user' } } }), 'aborted');
  assert.equal(turnEndReason({ reason: { kind: 'blocked' } }), 'aborted');
  assert.equal(turnEndReason({ reason: { kind: 'interrupted' } }), 'aborted');
  assert.equal(turnEndReason({ reason: { kind: 'max-tokens' } }), 'error');
  assert.equal(turnEndReason({ reason: { kind: 'another-plugins-kind' } }), 'error');
});

test('commands come typed from the dsh command registry, never from a prompt', () => {
  assert.deepEqual(profile.commands.parse({ command: 'evolver-search', arguments: '  redis retries ' }), { name: 'evolver-search', args: 'redis retries' });
  assert.equal(profile.commands.parse({ messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: '/evolver-status' }] }] }), null);
  assert.equal(profile.commands.answerReachesModel, true);
});

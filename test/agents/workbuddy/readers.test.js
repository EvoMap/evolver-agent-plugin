import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import profile from '../../../agents/workbuddy/profile.js';
import { checkEvidenceOf } from '../../../lib/checks.js';
import { transcripts } from '../../../lib/runtime/transcripts.js';

const fixture = (name) => new URL(`../../fixtures/workbuddy/${name}`, import.meta.url);
const PAYLOADS = JSON.parse(readFileSync(fixture('hook-payloads.json'), 'utf8'));
const LRU_TURN = readFileSync(fixture('lru-turn.jsonl'), 'utf8');
const line = (record) => `${JSON.stringify(record)}\n`;
const userPrompt = (text, providerData = { startsNewUserRequest: true }) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }], providerData });
const ANSWER = PAYLOADS.assistantMessage;

function transcriptWith(text) {
  const file = join(mkdtempSync(join(tmpdir(), 'workbuddy-transcript-')), 'session.jsonl');
  writeFileSync(file, text);
  return file;
}

const contextOf = (file, turnStart) => ({ transcriptSize: () => transcripts.size(file), transcriptSince: (offset) => transcripts.readSince(file, offset), turnStart });
const markOf = (file) => profile.evidence.turnStart(PAYLOADS.UserPromptSubmit, contextOf(file));
const turnOf = (file, mark) => profile.evidence.turnRecord(PAYLOADS.FinalStop, contextOf(file, mark));

const bashRecords = (command, text, { status = 'completed', callId = 'c1', args = {} } = {}) => [
  { type: 'function_call', name: 'Bash', callId, arguments: JSON.stringify({ command, ...args }) },
  { type: 'function_call_result', name: 'Bash', callId, status, output: { type: 'text', text } },
];
const shellText = (command, stdout, exit) => `Command: ${command}\nStdout: ${stdout}\nStderr: (empty)\nExit Code: ${exit}\nSignal: (none)`;

test('the hook payloads WorkBuddy sends read as one session, with no project at session start', () => {
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'FinalStop', 'SessionEnd']) {
    assert.equal(profile.payload.sessionId(PAYLOADS[event]), '01a12002-706d-79c9-a210-fbc680bb6d83');
    assert.equal(profile.payload.isSubagent(PAYLOADS[event]), false);
    assert.equal(profile.payload.transcriptPath(PAYLOADS[event]), PAYLOADS[event].transcript_path);
  }
  assert.equal(profile.payload.projectDir(PAYLOADS.SessionStart), null);
  assert.equal(profile.payload.projectDir(PAYLOADS.FinalStop), '/Users/me/project');
  assert.equal(profile.payload.prompt(PAYLOADS.UserPromptSubmit), '用 Node 写一个 LRU 缓存，带测试');
  assert.equal(profile.payload.isSubagent({ ...PAYLOADS.FinalStop, agent_id: 'agent-1' }), true);
});

test('every hook event and both command-script events map onto a canonical event', () => {
  assert.deepEqual(profile.events, {
    SessionStart: 'sessionStart', UserPromptSubmit: 'prompt', PreToolUse: 'beforeEdit', FinalStop: 'turnEnd', SessionEnd: 'sessionEnd', Command: 'command', AgentGene: 'agentGene',
  });
});

test('an edit tool names the file it is about to change, resolved against the session folder', () => {
  assert.equal(profile.evidence.editedFile(PAYLOADS.PreToolUse), '/Users/me/project/lru-cache.js');
  assert.equal(profile.evidence.editedFile({ ...PAYLOADS.PreToolUse, tool_name: 'NotebookEdit', tool_input: { notebook_path: '/abs/n.ipynb' } }), '/abs/n.ipynb');
  assert.equal(profile.evidence.editedFile({ ...PAYLOADS.PreToolUse, tool_name: 'Read' }), null);
  assert.equal(profile.evidence.toolNote(PAYLOADS.PreToolUse), null);
});

test('final_stop_reason says how the turn ended, and a missing one is the host\'s default, completed', () => {
  const reasonOf = (finalStopReason) => profile.turnEnd.reason({ ...PAYLOADS.FinalStop, final_stop_reason: finalStopReason });
  assert.deepEqual(['completed', undefined, 'interrupted', 'cancelled', 'failed', 'refusal'].map(reasonOf), ['answer', 'answer', 'aborted', 'aborted', 'error', 'error']);
});

test('a WorkBuddy turn yields its commands, paths, edited files and checks from the transcript', () => {
  const file = transcriptWith(line(userPrompt('earlier')));
  const mark = markOf(file);
  appendFileSync(file, LRU_TURN);
  const turn = turnOf(file, mark);
  assert.deepEqual(turn.checks, [
    { command: 'cd /tmp/lru-e2e && node --test 2>&1 | tail -12', failed: true },
    { command: 'cd /tmp/lru-e2e && node --test 2>&1 | tail -9', failed: false },
  ]);
  assert.deepEqual(turn.edits, ['/tmp/lru-e2e/lru-cache.test.js', '/tmp/lru-e2e/lru-cache.js']);
  assert.ok(turn.paths.includes('/tmp/lru-e2e/lru-cache.js'));
  assert.deepEqual(checkEvidenceOf(turn.checks), { kind: 'test', passed: true, fail_then_pass: true });
});

test('an edit the host refused is no edited file, and a background run is no check', () => {
  const turn = turnOf(transcriptWith(LRU_TURN), { at: 0, chars: 0, fingerprint: '811c9dc5' });
  assert.ok(!turn.edits.includes('/tmp/lru-e2e/README.md'));
  assert.ok(!turn.checks.some((check) => check.command.includes('--watch')));
  assert.ok(turn.commands.includes('node --test --watch'));
});

test('a non-zero exit or failure output fails a check; an incomplete call failed; one without a result says nothing', () => {
  const checksOf = (records) => turnOf(transcriptWith(records.map(line).join('')), null).checks;
  assert.equal(checksOf(bashRecords('npm run build', shellText('npm run build', 'done', 2)))[0].failed, true);
  assert.equal(checksOf(bashRecords('npm test | tail -3', shellText('npm test | tail -3', 'AssertionError: expected 1 to equal 2\n1 test failed', 0)))[0].failed, true);
  assert.equal(checksOf(bashRecords('npm test -- --grep "test failed"', shellText('npm test', 'ℹ pass 4\nℹ fail 0', 0)))[0].failed, false);
  assert.equal(checksOf(bashRecords('npm test', 'Interrupted', { status: 'incomplete' }))[0].failed, true);
  assert.deepEqual(checksOf([bashRecords('npm test', '')[0]]), []);
  assert.equal(checksOf(bashRecords('npm test', shellText('npm test', 'ℹ fail 0', 0)).map((record) => ({ ...record, name: 'PowerShell' }))).length, 1);
});

test('the answer and the model come from the latest turn: the requested model first, then the one that served it', () => {
  const file = transcriptWith([userPrompt('old'), { ...ANSWER, content: [{ type: 'output_text', text: 'old answer' }] }, userPrompt('new'), ...bashRecords('npm test', shellText('npm test', 'ok', 0)), ANSWER].map(line).join(''));
  const context = contextOf(file);
  assert.equal(profile.turnEnd.answer(PAYLOADS.FinalStop, context), 'LRU 缓存写好了：Map 加双向链表，10 个测试全部通过。');
  assert.deepEqual(profile.payload.model(PAYLOADS.FinalStop, context), { model: 'fast-model' });
  const routed = transcriptWith([userPrompt('x'), { ...ANSWER, providerData: { model: 'glm-5' } }].map(line).join(''));
  assert.deepEqual(profile.payload.model(PAYLOADS.FinalStop, contextOf(routed)), { model: 'glm-5' });
  const unanswered = transcriptWith([userPrompt('x'), ANSWER, userPrompt('interrupted')].map(line).join(''));
  assert.equal(profile.turnEnd.answer(PAYLOADS.FinalStop, contextOf(unanswered)), '');
  assert.equal(profile.payload.model(PAYLOADS.FinalStop, contextOf(unanswered)), null);
});

test('a user message the host adds inside a turn does not cut it', () => {
  const file = transcriptWith([userPrompt('fix it'), ...bashRecords('npm test', shellText('npm test', 'ok', 0)), userPrompt('Stop hook feedback: go on', { isMeta: true, startsNewUserRequest: false }), ANSWER].map(line).join(''));
  assert.deepEqual(turnOf(file, null).commands, ['npm test']);
  assert.equal(profile.turnEnd.answer(PAYLOADS.FinalStop, contextOf(file)), ANSWER.content[0].text);
});

test('only records after the turn\'s mark are read, and a shrunken transcript falls back to the last prompt', () => {
  const earlier = bashRecords('npm test', shellText('npm test', 'fail', 1), { callId: 'old' });
  const file = transcriptWith(earlier.map(line).join(''));
  const mark = markOf(file);
  appendFileSync(file, bashRecords('npm run lint', shellText('npm run lint', 'ok', 0), { callId: 'new' }).map(line).join(''));
  assert.deepEqual(turnOf(file, mark).commands, ['npm run lint']);
  writeFileSync(file, [userPrompt('new'), { ...ANSWER, content: [{ type: 'output_text', text: 'answer' }] }].map(line).join(''));
  assert.deepEqual(turnOf(file, mark), { commands: [], paths: [], edits: [], checks: [], answer: 'answer' });
});

test('a transcript rewritten past the old mark is read from the last prompt, even with a line break at that offset', () => {
  const first = line(userPrompt('an earlier prompt'));
  const file = transcriptWith(first);
  const mark = markOf(file);
  const rewritten = line(userPrompt('x'.repeat(first.length - line(userPrompt('')).length)));
  assert.equal(rewritten.length, first.length);
  writeFileSync(file, [rewritten, line(userPrompt('new')), ...bashRecords('npm test', shellText('npm test', 'ℹ fail 0', 0)).map(line)].join(''));
  assert.deepEqual(turnOf(file, mark).commands, ['npm test']);
});

test('a turn with no mark is read from the last prompt, and a missing or half-written transcript is an empty turn', () => {
  const file = transcriptWith([...bashRecords('npm run build', shellText('npm run build', 'ok', 0), { callId: 'old' }), userPrompt('new'), ...bashRecords('npm test', shellText('npm test', 'ℹ fail 0', 0))].map(line).join(''));
  assert.deepEqual(turnOf(file, null).commands, ['npm test']);
  assert.deepEqual(turnOf(join(tmpdir(), 'no-such-transcript.jsonl'), null).commands, []);
  const partial = transcriptWith('{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}\n{"type":"func');
  assert.equal(turnOf(partial, { at: 0, chars: 0, fingerprint: '811c9dc5' }).answer, 'hi');
});

test('a mark is small and holds no transcript text', () => {
  const file = transcriptWith(line(userPrompt('a secret prompt with token=ghp_abcdefghijklmnopqrstuvwxyz0123')));
  const mark = markOf(file);
  assert.deepEqual(Object.keys(mark), ['at', 'chars', 'fingerprint']);
  assert.doesNotMatch(JSON.stringify(mark), /secret|ghp_/);
});

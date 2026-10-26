import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { transcriptRecordOf } from '../../../agents/antigravity/evidence.js';
import profile from '../../../agents/antigravity/profile.js';
import { latestTurnOf, promptOf, stepsAfter, stepsOf, turnActivityOf } from '../../../agents/antigravity/transcript.js';

const fixture = (name) => readFileSync(new URL(`../../fixtures/antigravity/${name}`, import.meta.url), 'utf8');
const payloads = JSON.parse(fixture('payloads.json'));
const TRANSCRIPT = fixture('transcript_full.jsonl');
const LRU_PROMPT = '用 Node 写一个 LRU cache，带 get/set 和淘汰';
const contextOf = (text, extra = {}) => ({ transcriptSize: () => text.length, transcriptSince: () => text, ...extra });
const row = (fields) => JSON.stringify({ status: 'DONE', ...fields });

test('the prompt is the text inside USER_REQUEST, never the metadata Antigravity wraps around it', () => {
  assert.equal(promptOf('<USER_REQUEST>\nfix the flaky test\n</USER_REQUEST>\n<ADDITIONAL_METADATA>time</ADDITIONAL_METADATA>'), 'fix the flaky test');
  assert.equal(promptOf([{ type: 'text', text: 'plain prompt' }]), 'plain prompt');
});

test('the latest prompt of the person\'s names the turn, and a subagent\'s task is none', () => {
  const turn = latestTurnOf(stepsOf(TRANSCRIPT));
  assert.equal(turn.prompt, LRU_PROMPT);
  assert.deepEqual(turn.mark, { stepIndex: 3, createdAt: '2026-10-26T09:00:10.000Z' });
  assert.equal(turn.turnId, '3@2026-10-26T09:00:10.000Z');
  assert.equal(latestTurnOf(stepsOf('')), null);
  assert.equal(latestTurnOf(stepsOf(`{"cut off`)), null);
});

test('a turn record pairs each call with its result in step order: commands, checks, paths, edits and the answer', () => {
  const steps = stepsOf(TRANSCRIPT);
  const record = transcriptRecordOf(steps, latestTurnOf(steps).mark);
  assert.deepEqual(record.commands, ['node --test', 'npm run lint', 'node --test 2>&1 | tail -5', 'npm run build']);
  assert.deepEqual(record.checks, [
    { command: 'node --test', failed: true },
    { command: 'npm run lint', failed: false },
    { command: 'node --test 2>&1 | tail -5', failed: false },
  ], 'the build moved to the background has no verdict');
  assert.deepEqual(record.paths, ['/workspace/project/src/index.js', '/workspace/project/src/lru.js', '/workspace/project/src/index.js']);
  assert.deepEqual(record.edits, ['/workspace/project/src/lru.js'], 'the failed replacement edited nothing');
  assert.equal(record.answer, 'LRU 缓存写好了，node --test 通过。');
});

test('an exit code decides a check; without one an ERROR step fails it and the output is read', () => {
  const turn = (...rows) => `${row({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'run it' })}\n${rows.join('\n')}\n`;
  const call = (index, command) => row({ step_index: index, source: 'MODEL', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'run_command', args: { CommandLine: command } }] });
  const checksOf = (text) => transcriptRecordOf(stepsOf(text), { stepIndex: 0, createdAt: null }).checks;
  assert.deepEqual(checksOf(turn(call(1, 'npm test'), row({ step_index: 2, source: 'MODEL', type: 'RUN_COMMAND', status: 'ERROR', error: 'exit status 2' }))), [{ command: 'npm test', failed: true }]);
  assert.deepEqual(checksOf(turn(call(1, 'npm test'), row({ step_index: 2, source: 'MODEL', type: 'RUN_COMMAND', status: 'ERROR' }))), [{ command: 'npm test', failed: true }]);
  assert.deepEqual(checksOf(turn(call(1, 'npm test | tail -3'), row({ step_index: 2, source: 'MODEL', type: 'RUN_COMMAND', content: 'The command exited with code 0.\nOutput:\nAssertionError: expected 1 to equal 2' }))), [{ command: 'npm test | tail -3', failed: true }]);
  assert.deepEqual(checksOf(turn(call(1, 'npm test'))), [], 'a call no result answered was not run');
});

test('a turn ends at the next prompt, and a compaction that dropped its prompt still finds its steps', () => {
  const steps = stepsOf(TRANSCRIPT);
  const { mark } = latestTurnOf(steps);
  const next = row({ step_index: 21, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-10-26T09:01:00.000Z', content: 'next task' });
  const build = row({ step_index: 22, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-10-26T09:01:01.000Z', content: 'Next answer.' });
  assert.equal(turnActivityOf(stepsAfter(stepsOf(`${TRANSCRIPT}${next}\n${build}\n`), mark)).answer, 'LRU 缓存写好了，node --test 通过。');

  const compacted = [row({ step_index: 0, source: 'SYSTEM', type: 'CHECKPOINT', content: '{{ CHECKPOINT 1 }}' }), ...TRANSCRIPT.trim().split('\n').slice(4)].join('\n');
  assert.deepEqual(transcriptRecordOf(stepsOf(compacted), mark).commands, ['node --test', 'npm run lint', 'node --test 2>&1 | tail -5', 'npm run build']);
});

test('the payload readers take the conversation, the first workspace, the model and the transcript', () => {
  const { payload } = profile;
  assert.equal(payload.sessionId(payloads.PreInvocation), 'ec33ebf9-0cba-4100-8142-c61503f6c587');
  assert.equal(payload.projectDir(payloads.PreInvocation), '/workspace/project');
  assert.equal(payload.projectDir({ workspacePaths: ['file:///Users/me/my%20project'] }), '/Users/me/my project');
  assert.equal(payload.projectDir({ workspacePaths: [] }), null);
  assert.deepEqual(payload.model(payloads.Stop), { model: 'gemini-3.6-flash-medium' });
  assert.equal(payload.model({}), null);
  assert.match(payload.transcriptPath(payloads.Stop), /transcript\.jsonl$/);
  assert.equal(payload.isSubagent(payloads.PreInvocation), false);
  assert.equal(payload.isSubagent({ ...payloads.PreInvocation, parentConversationId: 'c-parent' }), true);
});

test('the prompt, turn id and turn start come from the transcript, read once per event', () => {
  let reads = 0;
  const context = contextOf(TRANSCRIPT, { transcriptSince: () => { reads += 1; return TRANSCRIPT; } });
  assert.equal(profile.payload.prompt(payloads.PreInvocation, context), LRU_PROMPT);
  assert.equal(profile.payload.turnId(payloads.PreInvocation, context), '3@2026-10-26T09:00:10.000Z');
  assert.deepEqual(profile.evidence.turnStart(payloads.PreInvocation, context), { stepIndex: 3, createdAt: '2026-10-26T09:00:10.000Z' });
  assert.equal(reads, 1);
  assert.equal(profile.payload.prompt(payloads.PreInvocation, contextOf('')), '');
  assert.equal(profile.payload.turnId(payloads.PreInvocation, contextOf('')), null);
});

test('at the turn end the record comes from the turn\'s start, and the answer from the latest turn', () => {
  const turnStart = { stepIndex: 3, createdAt: '2026-10-26T09:00:10.000Z' };
  assert.equal(profile.evidence.turnRecord(payloads.Stop, contextOf(TRANSCRIPT, { turnStart })).edits.length, 1);
  assert.equal(profile.evidence.turnRecord(payloads.Stop, contextOf(TRANSCRIPT, { turnStart: null })), null);
  assert.equal(profile.turnEnd.answer(payloads.Stop, contextOf(TRANSCRIPT)), 'LRU 缓存写好了，node --test 通过。');
});

test('only an edit tool\'s target is hashed before it runs', () => {
  assert.equal(profile.evidence.editedFile(payloads.PreToolUseEdit), '/workspace/project/src/lru.js');
  assert.equal(profile.evidence.editedFile(payloads.PreToolUse), null);
  assert.equal(profile.evidence.editedFile({}), null);
});

test('Stop\'s terminationReason says how the turn ended; a reason nobody named waits', () => {
  const reasonOf = (fields) => profile.turnEnd.reason({ ...payloads.Stop, ...fields });
  assert.equal(profile.turnEnd.reason(payloads.Stop), 'answer');
  assert.equal(profile.turnEnd.reason(payloads.StopNoToolCall), 'answer');
  assert.equal(reasonOf({ terminationReason: 'TERMINATION_REASON_NO_TOOL_CALL' }), 'answer');
  assert.equal(reasonOf({ terminationReason: 'max_steps_exceeded' }), 'error');
  assert.equal(reasonOf({ terminationReason: 'error', error: 'model unavailable' }), 'error');
  assert.equal(reasonOf({ terminationReason: 'model_stop', error: 'stream dropped' }), 'error');
  assert.equal(reasonOf({ terminationReason: 'CANCELED' }), 'aborted');
  assert.equal(reasonOf({ terminationReason: 'user_interrupt' }), 'aborted');
  assert.equal(reasonOf({ terminationReason: 'SOMETHING_NEW' }), 'unknown');
  assert.equal(reasonOf({ terminationReason: undefined }), 'unknown');
});

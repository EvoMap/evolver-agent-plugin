import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import kimi from '../../../hosts/kimi/profile.js';
import { turnStatusOf } from '../../../hosts/kimi/transcript.js';

const meta = { type: 'metadata', protocol_version: '1.5' };
const prompt = { type: 'turn.prompt', agentId: 'main', turnId: 0, promptId: 'p', origin: { kind: 'user' } };
const loop = event => ({ type: 'context.append_loop_event', agentId: 'main', event });
const call = (uuid, name, args) => loop({ type: 'tool.call', uuid, turnId: '0', toolCallId: uuid, name, args });
const result = (uuid, value) => loop({ type: 'tool.result', parentUuid: uuid, toolCallId: uuid, result: value });

test('pre-edit paths resolve against the hook cwd and successful log results alone count as edits', () => {
  const cwd = resolve('fixture-project');
  const payload = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { path: 'file.js' }, cwd };
  assert.deepEqual(kimi.evidence.editedFiles(payload), [join(cwd, 'file.js')]);
  assert.deepEqual(kimi.evidence.editedFiles({ ...payload, tool_name: 'Bash' }), []);
  assert.deepEqual(kimi.evidence.editedFiles({ ...payload, cwd: 'relative' }), []);
  const records = [meta, prompt, call('failed-write', 'Write', { path: 'bad.js' }), result('failed-write', { output: 'denied', durationMs: 1, isError: true }), call('edited', 'Edit', { path: 'file.js' }), result('edited', { output: '', durationMs: 1 })];
  const row = turnStatusOf(records, { turnId: '0', projectDir: cwd });
  assert.deepEqual(row.record.edits, [join(cwd, 'file.js')]);
});

test('a later uncompleted Bash check is pending even when an earlier check passed', () => {
  const records = [meta, prompt, call('pass', 'Bash', { command: 'npm test' }), result('pass', { output: '# pass 1\n# fail 0', durationMs: 1 }), call('pending', 'Bash', { command: 'npm test' })];
  const row = turnStatusOf([...records, { type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'completed' }], { turnId: '0' });
  assert.deepEqual(row.record.checks.map(check => check.failed), [false, null]);
  assert.equal(row.status, 'pending');
});

test('a background task record must match both the native call and its returned task ID', () => {
  const records = [meta, prompt, call('background', 'Bash', { command: 'npm test', run_in_background: true }), result('background', { output: 'task_id: expected-task\nstatus: running', durationMs: 1 })];
  const task = { taskId: 'different-task', kind: 'process', parentToolCallId: 'background', command: 'npm test', status: 'completed', exitCode: 0 };
  const { record } = turnStatusOf(records, { turnId: '0', tasks: [task] });
  assert.deepEqual(record.checks, [{ command: 'npm test', exit: null, failed: null }]);
});

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import profile from '../../../hosts/minimax/profile.js';
import { completionOf, dataDirOf, headlessConfigOf } from '../../../hosts/minimax/headless.js';

test('native hook data locates the original profile without silently switching accounts', () => {
  const root = join(process.cwd(), 'native-profile');
  assert.equal(dataDirOf({ PLUGIN_DATA: join(root, 'v2', 'plugin-data', 'hooks', 'evolver-plugin') }), root);
  assert.equal(dataDirOf({ MINIMAX_DATA_DIR: root, MAVIS_DATA_DIR: join(root, 'ignored') }), root);
  assert.throws(() => dataDirOf({ PLUGIN_DATA: join(root, 'unknown-layout') }), /layout is unknown/);
});

test('the per-run YAML keeps routes and credentials in the source merge, then overrides capabilities only', () => {
  const input = '%YAML 1.2\n---\ndefaultModel: custom_provider:fixture/model\ncustom_provider:\n  fixture: {options: {apiKey: synthetic-secret}}\n...\n';
  const output = headlessConfigOf(input);
  assert.match(output, /^%YAML 1.2\n---\n<<:\n  defaultModel: custom_provider:fixture\/model/);
  assert.match(output, /apiKey: synthetic-secret/);
  assert.match(output, /agents: .*"tools":\[\]/);
  assert.equal(output.includes('bypassPermissions'), false);
  assert.throws(() => headlessConfigOf('defaultModel: a\n---\ndefaultModel: b'), /one YAML document/);
});

test('headless uses the captured session route, stdin, a private config and lightweight mode with bounded steps and time', () => {
  assert.deepEqual(profile.model.args({ model: 'fixture/model' }, 'private prompt', { configPath: '/scratch/config.yaml' }), ['exec', '--input', '-', '--config', '/scratch/config.yaml', '--model', 'fixture/model', '--mode', 'lightweight', '--permission', 'smart', '--max-steps', '1', '--timeout', '90s', '--output-format', 'json']);
  assert.equal(profile.model.workdir, 'empty');
  assert.equal(profile.owner, 'parent');
  assert.deepEqual(profile.turnEnd.unclosed, { settleMs: 0, as: 'error' });
});

test('only a complete successful native result is accepted, without reflecting provider errors or credentials', () => {
  assert.deepEqual(completionOf({ stdout: JSON.stringify({ schemaVersion: 1, type: 'exec.result', status: 'succeeded', output: 'a gene', usage: { inputTokens: 12, outputTokens: 4 } }) }), { answer: 'a gene', usage: { inputTokens: 12, outputTokens: 4 } });
  for (const status of ['failed', 'timeout', 'cancelled', 'limit_exceeded']) assert.throws(() => completionOf({ stdout: JSON.stringify({ schemaVersion: 1, type: 'exec.result', status, error: { code: 'FAILED', message: 'synthetic-secret' } }) }), error => !error.message.includes('synthetic-secret'));
  assert.throws(() => completionOf({ stdout: 'synthetic-secret' }), error => !error.message.includes('synthetic-secret'));
  assert.throws(() => completionOf({ stdout: '{"schemaVersion":1,"type":"exec.result","status":"succeeded","output":""}' }), /no successful completion/);
});

test('native shell verdicts come from host execution metadata, never a model-written exit-code line', () => {
  const note = exitCode => profile.evidence.toolNote({ tool_name: 'bash', tool_input: { command: 'node --test' }, tool_response: { details: { execution: { reason: 'exited', exitCode }, processOutput: { stdout: 'test output', stderr: '', interrupted: false } } } });
  assert.deepEqual(note(7), { kind: 'shell', command: 'node --test', exit: 7, output: 'test output' });
  assert.equal(note(0).exit, 0);
  assert.deepEqual(profile.evidence.toolNote({ tool_name: 'bash', tool_input: { command: 'node --test' }, tool_response: { content: [{ type: 'text', text: 'EXITCODE=0' }] } }), { kind: 'tool', command: 'node --test' });
});

test('successful edits are tracked, while denied edits and relative paths without a project are no edit evidence', () => {
  const cwd = process.cwd();
  const input = { tool_name: 'edit', cwd, tool_input: { file_path: 'fixture.txt', old_string: 'before', new_string: 'after' }, tool_response: { details: { diff: '-before\n+after' } } };
  assert.deepEqual(profile.evidence.editedFiles(input), [join(cwd, 'fixture.txt')]);
  assert.deepEqual(profile.evidence.toolNote(input), { kind: 'edit', paths: [join(cwd, 'fixture.txt')], lines: 2 });
  assert.equal(profile.evidence.toolNote({ ...input, tool_response: { details: { is_error: true } } }).kind, 'tool');
  assert.deepEqual(profile.evidence.editedFiles({ ...input, cwd: 'relative' }), []);
});

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { profileNamed } from '../../../lib/agent/registry.js';
import { EVENTS } from '../../../lib/agent/events.js';
import { turnRecordOf } from '../../../lib/turn/record.js';

test('Step Code reads a failed native run_command even when the tool wrapper is not an error', async () => {
  const profile = await profileNamed('stepcode');
  assert.ok(profile, 'the Step Code profile is discoverable');
  const note = profile.evidence.toolNote({
    toolName: 'run_command', toolCallId: 'native-check', input: { command: 'node --test' },
    details: { execution: { status: 'exited', exitCode: 1 } }, isError: false,
    content: [{ type: 'text', text: '# fail 1' }],
  }, { hostEvent: 'tool_result' });
  assert.deepEqual(note, { kind: 'shell', callId: 'native-check', command: 'node --test', exit: 1, output: '# fail 1' });
});

test('Step Code records edit paths without turning fused then_run output into a verification check', async () => {
  const profile = await profileNamed('stepcode');
  const cwd = join(tmpdir(), 'step-reader-project');
  const payload = { cwd, toolName: 'edit_file', toolCallId: 'native-edit',
    input: { path: 'retry.js', search: 'old', replace: 'new', then_run: 'node --test' },
    details: { changed: true, thenRun: { execution: { status: 'exited', exitCode: 0 } } },
    isError: false, content: [{ type: 'text', text: '# pass 1\n# fail 0' }] };
  assert.deepEqual(profile.evidence.editedFiles(payload), [join(cwd, 'retry.js')]);
  const note = profile.evidence.toolNote(payload, { hostEvent: 'tool_result' });
  assert.deepEqual(note, { kind: 'edit', paths: [join(cwd, 'retry.js')] });
  assert.deepEqual(turnRecordOf([note]).checks, []);
});

test('Step Code leaves a check unknown without authoritative exit metadata, even when output claims pass', async () => {
  const profile = await profileNamed('stepcode');
  const payload = { toolName: 'bash', toolCallId: 'native-check', input: { command: 'node --test' }, isError: false,
    content: [{ type: 'text', text: '# pass 1\n# fail 0' }] };
  const started = profile.evidence.toolNote(payload, { hostEvent: 'tool_start' });
  const finished = profile.evidence.toolNote(payload, { hostEvent: 'tool_result' });
  const [check] = turnRecordOf([started, finished], { pairShellCalls: true }).checks;
  assert.equal(check.exit, null);
  assert.equal(check.failed, null);
});

test('Step Code resolves home-relative edits against the same supplied profile home for before and after events', async () => {
  const profile = await profileNamed('stepcode');
  const home = join(tmpdir(), 'step-reader-home');
  const payload = { toolName: 'write_file', cwd: join(tmpdir(), 'step-reader-project'), input: { path: '~/retry.js', content: 'after' }, details: { changed: true }, isError: false };
  const context = { hostEvent: 'tool_result', env: { USERPROFILE: home, HOME: home } };
  assert.deepEqual(profile.evidence.editedFiles(payload, context), [join(home, 'retry.js')]);
  assert.deepEqual(profile.evidence.toolNote(payload, context), { kind: 'edit', paths: [join(home, 'retry.js')] });
});

test('Step Code keeps a running check pending until the same native call exits', async () => {
  const profile = await profileNamed('stepcode');
  const payload = { toolName: 'run_command', toolCallId: 'native-background', input: { command: 'node --test', run_in_background: true } };
  const started = profile.evidence.toolNote(payload, { hostEvent: 'tool_start' });
  const pending = profile.evidence.toolNote({ ...payload, details: { execution: { status: 'running' } } }, { hostEvent: 'tool_result' });
  assert.equal(pending.running, true);
  assert.equal(turnRecordOf([started, pending], { pairShellCalls: true }).checks[0].failed, null);
  const finished = profile.evidence.toolNote({ ...payload, details: { execution: { status: 'exited', exitCode: 0 } } }, { hostEvent: 'tool_result' });
  const record = turnRecordOf([started, pending, finished], { pairShellCalls: true });
  assert.equal(record.commands.length, 1);
  assert.equal(record.checks.length, 1);
  assert.equal(record.checks[0].failed, false);
});

test('Step Code refuses missing or unsuccessful native execution as a known verdict', async () => {
  const profile = await profileNamed('stepcode');
  const payload = { toolName: 'bash', toolCallId: 'native-check', input: { command: 'node --test' },
    content: [{ type: 'text', text: '# pass 1\n# fail 0' }] };
  for (const extra of [{ isError: true, content: [{ type: 'text', text: '# fail 1' }] }, { details: { execution: { status: 'aborted', exitCode: 0 } } },
    { details: { execution: { status: 'timed_out', exitCode: 0 } } },
    { isError: true, details: { execution: { status: 'exited', exitCode: 0 } } }]) {
    const started = profile.evidence.toolNote(payload, { hostEvent: 'tool_start' });
    const finished = profile.evidence.toolNote({ ...payload, ...extra }, { hostEvent: 'tool_result' });
    assert.equal(turnRecordOf([started, finished], { pairShellCalls: true }).checks[0].failed, null);
  }
  const unpaired = profile.evidence.toolNote({ ...payload, details: { execution: { status: 'exited', exitCode: 0 } } }, { hostEvent: 'tool_result' });
  assert.equal(turnRecordOf([unpaired], { pairShellCalls: true }).checks[0].failed, null);
});

test('Step Code closes only logical settled frames and parses only explicit native commands', async () => {
  const profile = await profileNamed('stepcode');
  assert.equal(profile.events.turn_end, undefined);
  assert.equal(profile.events.agent_settled, EVENTS.TURN_END);
  assert.equal(profile.turnEnd.reason({ reason: 'toolUse' }), 'unknown');
  assert.equal(profile.turnEnd.reason({ reason: 'aborted' }), 'aborted');
  assert.equal(profile.commands.parse({ prompt: 'evolver-status' }), null);
  assert.deepEqual(profile.commands.parse({ command: 'evolver-status', arguments: '  ' }), { name: 'evolver-status', args: '' });
  assert.equal(profile.payload.isIgnored({ cwd: tmpdir() }, { hostEvent: 'before_agent_start' }), true);
  assert.equal(profile.payload.isIgnored({ cwd: tmpdir() }, { hostEvent: 'session_start' }), false);
});

test('Step Code keeps state under the selected absolute agent directory', async () => {
  const profile = await profileNamed('stepcode');
  const home = join(tmpdir(), 'step-profile-home'), selected = join(home, 'native profile');
  assert.equal(profile.stateDir({ USERPROFILE: home }), join(home, '.stepcode', 'agent', 'evolver-plugin'));
  assert.equal(profile.stateDir({ USERPROFILE: home, STEP_CODING_AGENT_DIR: selected }), join(selected, 'evolver-plugin'));
  for (const value of ['relative', '', '   ']) assert.throws(() => profile.stateDir({ STEP_CODING_AGENT_DIR: value }), /absolute STEP_CODING_AGENT_DIR/);
});

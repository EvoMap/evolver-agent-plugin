import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import kimi from '../../../hosts/kimi/profile.js';
import { ownerProbeOf } from '../../../lib/runtime/process/owner.js';

const payload = { session_id: 'session-fixture', cwd: join('D:', 'fixture'), client_type: 'kimi_code_cli', hook_event_name: 'UserPromptSubmit', prompt: [{ type: 'text', text: '  Fix retry. ' }, { type: 'image', image_url: 'untrusted' }, { type: 'text', text: 'Run tests.' }], is_steer: false };

test('Windows Desktop hooks use the Kimi session contract and require a Kimi ancestor', () => {
  const desktop = { ...payload, client_type: 'kimi_code_desktop' };
  assert.equal(kimi.payload.isIgnored(desktop), false);
  assert.equal(kimi.payload.isIgnored({ ...desktop, is_steer: true }), true);
  assert.equal(kimi.payload.isIgnored({ ...desktop, client_type: 'kimi_code_vscode' }), true);
  const owner = (name) => ownerProbeOf(kimi.owner, {
    platform: 'win32', windowsAncestry: kimi.windowsAncestry,
    probe: (pid) => pid === process.ppid ? { name: 'cmd.exe', ppid: 4242 }
      : pid === 4242 ? { name, ppid: 1 } : null,
  }).current();
  assert.equal(owner('Kimi Code.exe'), 4242);
  assert.equal(owner('kimi.exe'), 4242);
  assert.equal(owner('Other Kimi Code.exe'), null);
});

test('Kimi uses its native prompt message contract and observer events cannot inject context', () => {
  assert.equal(kimi.payload.prompt(payload), 'Fix retry. \nRun tests.');
  assert.deepEqual(kimi.reply.context('Recall text', 'UserPromptSubmit'), { message: 'Recall text' });
  assert.deepEqual(kimi.reply.context('Ignored', 'PostToolUse'), {});
  assert.deepEqual(kimi.reply.notice('Later notice', 'SessionStart'), {});
  assert.equal(kimi.reply.toolResultContext, false);
  assert.equal(kimi.commands.entry, 'cli-only');
  assert.deepEqual(kimi.native.events, ['TurnStarted', 'Stop', 'StopFailure', 'Interrupt', 'TaskStarted', 'Notification']);
  for (const event of kimi.native.events) assert.equal(kimi.events[event], undefined);
});

test('native profile scope and turn zero survive identity normalization; steer and foreign agents are ignored', () => {
  const home = join('fixture', 'profile-a');
  const a = kimi.payload.sessionId(payload, { env: { KIMI_CODE_HOME: home }, nativeScope: 'a'.repeat(64) });
  const b = kimi.payload.sessionId(payload, { env: { KIMI_CODE_HOME: join('fixture', 'profile-b') }, nativeScope: 'b'.repeat(64) });
  assert.notEqual(a, b);
  assert.equal(a.includes(home), false);
  assert.equal(kimi.payload.sessionId(payload, { env: { KIMI_CODE_HOME: home } }), null);
  assert.equal(kimi.payload.sessionId(payload, { nativeScope: home }), null);
  assert.equal(kimi.payload.sessionId({ ...payload, session_id: 'x'.repeat(129) }, { nativeScope: 'a'.repeat(64) }), null);
  assert.equal(kimi.payload.turnId({ ...payload, hook_event_name: 'TurnStarted', turn_id: 0 }), '0');
  assert.equal(kimi.payload.turnId({ ...payload, turn_id: 9 }), null);
  assert.equal(kimi.payload.turnId({ ...payload, hook_event_name: 'PostToolUse' }, { nativeFacts: { toolTurnId: '0' } }), '0');
  assert.equal(kimi.payload.isIgnored(payload), false);
  for (const changed of [{ is_steer: true }, { agent_id: 'helper' }, { origin_kind: 'cron' }, { client_type: 'unknown' }]) assert.equal(kimi.payload.isIgnored({ ...payload, ...changed }), true);
  assert.equal(kimi.payload.sessionId({ session_id: '../outside' }), null);
});

test('global default model and truncated hook output are never candidate authority', () => {
  const facts = { status: 'ok', schemaSupported: true, bind: { turnId: '0' }, modelHint: { alias: 'route-b', effort: 'off' }, terminal: { turnId: '0', reason: 'failed', answer: '' }, record: { checks: [{ command: 'npm test', failed: true }] }, toolTurnId: '0' };
  assert.equal(kimi.payload.model({ ...payload, model: 'default-a' }), null);
  assert.deepEqual(kimi.payload.model(payload, { nativeFacts: facts }), facts.modelHint);
  assert.equal(kimi.evidence.toolNote({ ...payload, tool_output: 'tests passed' }), null);
  assert.equal(kimi.turnEnd.reason(payload), 'unknown');
  assert.equal(kimi.turnEnd.reason(payload, { nativeFacts: facts }), 'error');
  assert.deepEqual(kimi.evidence.turnRecord(payload, { nativeFacts: facts }), facts.record);
  assert.equal(kimi.evidence.turnRecord(payload, { nativeFacts: { ...facts, status: 'partial' } }), null);
});

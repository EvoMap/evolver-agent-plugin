import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import kimi from '../../../hosts/kimi/profile.js';
import { EVENTS } from '../../../lib/agent/events.js';
import { ownerProbeOf } from '../../../lib/runtime/process/owner.js';

const payload = { session_id: 'session-fixture', cwd: join('D:', 'fixture'), client_type: 'kimi_code_cli', hook_event_name: 'UserPromptSubmit', prompt: [{ type: 'text', text: '  Fix retry. ' }, { type: 'image', image_url: 'untrusted' }, { type: 'text', text: 'Run tests.' }], is_steer: false };

const owner = (name) => ownerProbeOf(kimi.owner, {
  platform: 'win32', windowsAncestry: kimi.windowsAncestry,
  probe: (pid) => pid === process.ppid ? { name: 'cmd.exe', ppid: 4242 }
    : pid === 4242 ? { name, ppid: 1 } : null,
}).current();

test('Windows CLI hooks still accept a Kimi CLI ancestor', () => {
  assert.equal(kimi.payload.isIgnored(payload), false);
  assert.equal(owner('kimi.exe'), 4242);
  assert.equal(owner('kimi-code.exe'), 4242);
});

test('Windows Desktop hooks accept the local Desktop client and Kimi Code owner', () => {
  const desktop = { ...payload, client_type: 'kimi_code_desktop' };
  assert.equal(kimi.payload.isIgnored(desktop), false);
  assert.equal(kimi.payload.isIgnored({ ...desktop, is_steer: true }), true);
  assert.equal(kimi.payload.isIgnored({ ...desktop, client_type: 'kimi_code_vscode' }), true);
  assert.equal(owner('Kimi Code.exe'), 4242);
  assert.equal(owner('Other Kimi Code.exe'), null);
});

test('Kimi uses its native prompt message contract and lifecycle hooks cannot inject context', () => {
  assert.equal(kimi.payload.prompt(payload), 'Fix retry. \nRun tests.');
  assert.equal(kimi.payload.prompt({ ...payload, hook_event_name: 'TurnStarted', prompt: ' Fix retry. ' }), 'Fix retry.');
  assert.deepEqual(kimi.reply.context('Recall text', 'UserPromptSubmit'), { message: 'Recall text' });
  assert.deepEqual(kimi.reply.context('Ignored', 'Stop'), {});
  assert.deepEqual(kimi.reply.notice('Later notice', 'SessionStart'), {});
  assert.equal(kimi.reply.toolResultContext, false);
  assert.equal(kimi.commands.entry, 'cli-only');
  for (const event of ['TurnStarted', 'Stop', 'StopFailure', 'Interrupt', 'Notification']) assert.equal(kimi.events[event], EVENTS.TURN_START);
  assert.equal(kimi.turnEnd.statusRecord.confirmCompletion, true);
});

test('native profile scope and turn zero survive identity normalization; steer and foreign agents are ignored', () => {
  const home = join('fixture', 'profile-a');
  const a = kimi.payload.sessionId(payload, { env: { KIMI_CODE_HOME: home }, recordScope: 'a'.repeat(64) });
  const b = kimi.payload.sessionId(payload, { env: { KIMI_CODE_HOME: join('fixture', 'profile-b') }, recordScope: 'b'.repeat(64) });
  assert.notEqual(a, b);
  assert.equal(a.includes(home), false);
  assert.equal(kimi.turnEnd.statusRecord.nativeSessionOf(a, 'a'.repeat(64)), 'session-fixture');
  assert.equal(kimi.turnEnd.statusRecord.nativeSessionOf(a, 'b'.repeat(64)), null);
  assert.equal(kimi.payload.sessionId(payload, { env: { KIMI_CODE_HOME: home } }), null);
  assert.equal(kimi.payload.sessionId(payload, { recordScope: home }), null);
  assert.equal(kimi.payload.sessionId({ ...payload, session_id: 'x'.repeat(129) }, { recordScope: 'a'.repeat(64) }), null);
  assert.equal(kimi.payload.turnId({ ...payload, hook_event_name: 'TurnStarted', turn_id: 0 }), '0');
  assert.equal(kimi.payload.turnId({ ...payload, turn_id: 9 }), null);
  assert.equal(kimi.payload.isIgnored(payload), false);
  for (const changed of [{ is_steer: true }, { agent_id: 'helper' }, { origin_kind: 'cron' }, { client_type: 'unknown' }]) assert.equal(kimi.payload.isIgnored({ ...payload, ...changed }), true);
  assert.equal(kimi.payload.sessionId({ session_id: '../outside' }), null);
});

test('global default model and truncated hook output are never candidate authority', () => {
  assert.equal(kimi.payload.model({ ...payload, model: 'default-a' }), null);
  assert.equal(kimi.evidence.toolNote({ ...payload, tool_output: 'tests passed' }), null);
  assert.equal(kimi.evidence.turnRecord, undefined);
});

test('a turn\'s route is the one its log names, under the stamp it began and ended with', () => {
  const route = { alias: 'custom/model-b', model: 'upstream-b', protocol: 'openai', effort: null };
  assert.deepEqual(kimi.turnEnd.modelOf({ model: route }, 'stamp', 'stamp'), { selection: route, configDigest: 'stamp' });
  assert.deepEqual(kimi.turnEnd.modelOf({ model: route }, 'stamp', 'other'), { unavailable: 'route_changed' });
  assert.deepEqual(kimi.turnEnd.modelOf({ model: route }, null, 'stamp'), { unavailable: 'credential_missing' });
  assert.deepEqual(kimi.turnEnd.modelOf({ model: null }, 'stamp', 'stamp'), { unavailable: 'route_unresolved' });
});

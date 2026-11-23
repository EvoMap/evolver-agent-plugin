import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCommand } from '../../lib/app/commands/index.js';
import { memoryPorts } from './memory-ports.js';

const RUNNING = { running: true, health: { pid: 81 }, hub_mode: 'public', node_id: 'node_1', hub_auth_status: 'ok', outbound_pending: 0, inbound_pending: 0 };

function statusWorld({ outcome, installed, proxyVersion, proxyPid = 81 }) {
  const { ports } = memoryPorts();
  ports.proxy = { request: async (method, path) => (path === '/proxy/status' ? { ok: true, data: RUNNING } : { ok: false, error: 'unexpected' }) };
  ports.client = { versions: () => ({ agent: 'dsh', agentVersion: '0.2.1', plugin: '@evomap/evolver-agent-plugin', pluginVersion: '1.0.16' }) };
  ports.engine = { ...ports.engine, outcome: async () => outcome, current: async () => ({ installed, proxy: { version: proxyVersion, pid: proxyPid } }) };
  return ports;
}

const status = async (ports) => JSON.parse((await runCommand(ports, { sessionId: 's1', name: 'evolver-status' })).text);

test('/evolver-status prints the plugin, agent, installed Evolver and running Proxy versions as JSON', async () => {
  const answer = await status(statusWorld({ outcome: null, installed: { version: '2.0.55', source: 'path' }, proxyVersion: '2.0.55' }));
  assert.deepEqual(answer.plugin, { name: '@evomap/evolver-agent-plugin', version: '1.0.16' });
  assert.equal(answer.agent.version, '0.2.1');
  assert.deepEqual(answer.evolver.installed, { version: '2.0.55', source: 'path' });
  assert.equal(answer.evolver.proxy.version, '2.0.55');
  assert.equal(answer.evolver.proxy.node_id, 'node_1');
  assert.match(answer.evolver.required, /^>=\d+\.\d+\.\d+$/);
});

test('/evolver-status does not show an old start failure as current once a new enough Proxy runs', async () => {
  const failed = { version: '2.0.50', source: 'path', status: 'start_failed', error: 'the Proxy did not answer within the wait', at: 1794967906012, retryAt: 1794977506012 };
  const answer = await status(statusWorld({ outcome: failed, installed: { version: '2.0.55', source: 'path' }, proxyVersion: '2.0.55' }));
  assert.deepEqual(answer.engine_setup, { status: 'ready', previous: { status: 'start_failed', version: '2.0.50', at: '2026-11-18T02:11:46.012Z' } });
});

test('/evolver-status names no Proxy version recorded for a process other than the one answering, and cures nothing with it', async () => {
  const failed = { version: '2.0.50', source: 'path', status: 'start_failed', error: 'the Proxy did not answer within the wait', at: 1 };
  const answer = await status(statusWorld({ outcome: failed, installed: { version: '2.0.55', source: 'path' }, proxyVersion: '2.0.55', proxyPid: 82 }));
  assert.equal(answer.evolver.proxy.version, null);
  assert.equal(answer.evolver.proxy.pid, 81);
  assert.equal(answer.engine_setup.status, 'start_failed');
});

test('/evolver-status names no Proxy version when either side gives no process to pair it with', async () => {
  const unpaired = await status(statusWorld({ outcome: null, installed: null, proxyVersion: '2.0.55', proxyPid: null }));
  assert.equal(unpaired.evolver.proxy.version, null);
  const ports = statusWorld({ outcome: null, installed: null, proxyVersion: '2.0.55' });
  ports.proxy = { request: async () => ({ ok: true, data: { ...RUNNING, health: {} } }) };
  assert.equal((await status(ports)).evolver.proxy.version, null);
});

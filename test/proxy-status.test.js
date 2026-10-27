import assert from 'node:assert/strict';
import { test } from 'node:test';

import { proxyStatusText, registeredNodeOf, registrationText } from '../lib/proxy-status.js';

test('a running Proxy is summarised by node, pending counts and last sync', () => {
  const text = proxyStatusText({ running: true, hub_mode: 'public', node_id: 'node_1', outbound_pending: 2, inbound_pending: 0, last_sync_at: '2026-10-22T03:00:00Z' });
  assert.equal(text, 'Evolver Proxy running (public hub, node node_1).\nPending: 2 outbound, 0 inbound; last Hub sync 2026-10-22T03:00:00Z.');
});

test('a sync error and auth status are surfaced; a non-running answer is said plainly', () => {
  assert.match(proxyStatusText({ running: true, last_sync_error: 'hub 503', hub_auth_status: 'ok' }), /node unclaimed[\s\S]*last Hub sync failed: hub 503\.\nHub auth: ok\./);
  assert.match(proxyStatusText({ authorized: true }), /does not report itself running/);
});

test('a node counts as registered only while the Hub accepts it; anything else is reported as the Proxy saw it', () => {
  assert.equal(registeredNodeOf({ running: true, node_id: 'node_1', hub_auth_status: 'ok' }), 'node_1');
  for (const data of [{ node_id: 'node_1', hub_auth_status: 'auth_failed' }, { node_id: 'unclaimed', hub_auth_status: 'ok' }, { hub_auth_status: 'ok' }, { node_id: 'node_1' }, null]) {
    assert.equal(registeredNodeOf(data), null, JSON.stringify(data));
  }
  assert.equal(registrationText({ node_id: 'node_1', hub_auth_status: 'retired', last_sync_error: 'hub 410' }), 'Hub auth retired, node node_1, last Hub sync failed: hub 410');
  assert.equal(registrationText({ node_id: 'unclaimed' }), 'Hub auth not reported, node none');
});

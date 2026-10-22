import assert from 'node:assert/strict';
import { test } from 'node:test';

import { proxyStatusText } from '../lib/proxy-status.js';

test('a running Proxy is summarised by node, pending counts and last sync', () => {
  const text = proxyStatusText({ running: true, hub_mode: 'public', node_id: 'node_1', outbound_pending: 2, inbound_pending: 0, last_sync_at: '2026-10-22T03:00:00Z' });
  assert.equal(text, 'Evolver Proxy running (public hub, node node_1).\nPending: 2 outbound, 0 inbound; last Hub sync 2026-10-22T03:00:00Z.');
});

test('a sync error and auth status are surfaced; a non-running answer is said plainly', () => {
  assert.match(proxyStatusText({ running: true, last_sync_error: 'hub 503', hub_auth_status: 'ok' }), /node unclaimed[\s\S]*last Hub sync failed: hub 503\.\nHub auth: ok\./);
  assert.match(proxyStatusText({ authorized: true }), /does not report itself running/);
});

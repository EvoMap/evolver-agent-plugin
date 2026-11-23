import assert from 'node:assert/strict';
import { test } from 'node:test';

import { proxyStatusOf, publishingOf, registeredNodeOf, registrationText } from '../lib/proxy-status.js';

test('a running Proxy is described by its process, node, pending counts and last sync, an epoch-ms sync as ISO time', () => {
  const data = { running: true, health: { pid: 81 }, hub_mode: 'public', node_id: 'node_1', hub_auth_status: 'ok', outbound_pending: 2, inbound_pending: 0, last_sync_at: 1795399048557 };
  assert.deepEqual(proxyStatusOf(data), {
    running: true, pid: 81, hub_mode: 'public', node_id: 'node_1', hub_auth: 'ok', pending: { outbound: 2, inbound: 0 }, last_sync: '2026-11-23T01:57:28.557Z',
  });
});

test('a sync error is surfaced; a non-running answer is said plainly', () => {
  assert.equal(proxyStatusOf({ running: true, last_sync_at: '1795399048557' }).last_sync, '2026-11-23T01:57:28.557Z');
  assert.equal(proxyStatusOf({ running: true, last_sync_at: '2026-10-22T03:00:00Z' }).last_sync, '2026-10-22T03:00:00Z');
  const status = proxyStatusOf({ running: true, last_sync_error: 'hub 503' });
  assert.equal(status.node_id, 'unclaimed');
  assert.equal(status.last_sync, null);
  assert.equal(status.last_sync_error, 'hub 503');
  assert.deepEqual(proxyStatusOf({ authorized: true }), { running: false, error: 'The Evolver Proxy answered but does not report itself running.' });
});

test('the Proxy\'s background publishing is shown when it reports it: the verifier and why not, the counts, the last attempt', () => {
  const curation = {
    publish_verifier: 'unavailable', publish_verifier_reason: 'read_only_isolation_unavailable', awaiting_verification: 2, published: 5,
    last_attempt: { gene_asset_id: 'sha256:g1', result: 'not_reproducible', at: '2026-11-03T08:00:00Z' },
  };
  assert.deepEqual(publishingOf({ running: true, background_curation: curation }), {
    verifier: 'unavailable', verifier_reason: 'read_only_isolation_unavailable', awaiting_verification: 2, published: 5,
    last_attempt: { result: 'not_reproducible', gene_asset_id: 'sha256:g1', at: '2026-11-03T08:00:00Z' },
  });
  assert.equal(publishingOf({ running: true, background_curation: { publish_verifier: 'available' } }).last_attempt, null);
  assert.equal(publishingOf({ running: true }), null);
});

test('a node counts as registered only while the Hub accepts it; anything else is reported as the Proxy saw it', () => {
  assert.equal(registeredNodeOf({ running: true, node_id: 'node_1', hub_auth_status: 'ok' }), 'node_1');
  for (const data of [{ node_id: 'node_1', hub_auth_status: 'auth_failed' }, { node_id: 'unclaimed', hub_auth_status: 'ok' }, { hub_auth_status: 'ok' }, { node_id: 'node_1' }, null]) {
    assert.equal(registeredNodeOf(data), null, JSON.stringify(data));
  }
  assert.equal(registrationText({ node_id: 'node_1', hub_auth_status: 'retired', last_sync_error: 'hub 410' }), 'Hub auth retired, node node_1, last Hub sync failed: hub 410');
  assert.equal(registrationText({ node_id: 'unclaimed' }), 'Hub auth not reported, node none');
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

function lastSyncOf(data) {
  if (data.last_sync_error) return `last Hub sync failed: ${data.last_sync_error}`;
  return data.last_sync_at ? `last Hub sync ${data.last_sync_at}` : 'no Hub sync yet';
}

export function proxyStatusText(data) {
  if (!data || data.running !== true) return 'Evolver Proxy answered but does not report itself running.';
  return [
    `Evolver Proxy running (${data.hub_mode ?? 'public'} hub, node ${data.node_id ?? 'unclaimed'}).`,
    `Pending: ${Number(data.outbound_pending ?? 0)} outbound, ${Number(data.inbound_pending ?? 0)} inbound; ${lastSyncOf(data)}.`,
    ...(data.hub_auth_status ? [`Hub auth: ${data.hub_auth_status}.`] : []),
  ].join('\n');
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

function lastSyncOf(data) {
  if (data.last_sync_error) return `last Hub sync failed: ${data.last_sync_error}`;
  return data.last_sync_at ? `last Hub sync ${data.last_sync_at}` : 'no Hub sync yet';
}

const isNodeId = (id) => typeof id === 'string' && id !== '' && id !== 'unclaimed';

/** The node the Proxy registered with the Hub, while the Hub accepts it; else null. */
export function registeredNodeOf(data) {
  return data?.hub_auth_status === 'ok' && isNodeId(data.node_id) ? data.node_id : null;
}

/** What the Proxy reports of its Hub registration: auth status, node, and the last sync error. */
export function registrationText(data) {
  const parts = [`Hub auth ${data?.hub_auth_status ?? 'not reported'}`, `node ${isNodeId(data?.node_id) ? data.node_id : 'none'}`];
  return [...parts, ...(data?.last_sync_error ? [`last Hub sync failed: ${data.last_sync_error}`] : [])].join(', ');
}

export function proxyStatusText(data) {
  if (!data || data.running !== true) return 'Evolver Proxy answered but does not report itself running.';
  return [
    `Evolver Proxy running (${data.hub_mode ?? 'public'} hub, node ${data.node_id ?? 'unclaimed'}).`,
    `Pending: ${Number(data.outbound_pending ?? 0)} outbound, ${Number(data.inbound_pending ?? 0)} inbound; ${lastSyncOf(data)}.`,
    ...(data.hub_auth_status ? [`Hub auth: ${data.hub_auth_status}.`] : []),
  ].join('\n');
}

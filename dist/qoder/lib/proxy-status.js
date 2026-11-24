// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

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

const EPOCH_MS = /^\d{10,}$/;

/** An epoch-ms time, as a number or digits, as ISO text; other text as it is; null when absent. */
function timeOf(value) {
  const epochMs = typeof value === 'string' && EPOCH_MS.test(value) ? Number(value) : value;
  if (Number.isFinite(epochMs)) {
    const date = new Date(epochMs);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return typeof value === 'string' && value ? value : null;
}

function lastAttemptOf(attempt) {
  return attempt ? { result: attempt.result, gene_asset_id: attempt.gene_asset_id, at: timeOf(attempt.at) } : null;
}

/** The Proxy's background verification and publishing of distilled Genes; null from a Proxy that does not report it. */
export function publishingOf(data) {
  const curation = data?.background_curation;
  if (!curation || typeof curation !== 'object') return null;
  return {
    verifier: curation.publish_verifier ?? null,
    ...(curation.publish_verifier_reason && { verifier_reason: curation.publish_verifier_reason }),
    awaiting_verification: Number(curation.awaiting_verification ?? 0),
    published: Number(curation.published ?? 0),
    last_attempt: lastAttemptOf(curation.last_attempt),
  };
}

/** What a `/proxy/status` answer says of the Proxy itself and its Hub link. */
export function proxyStatusOf(data) {
  if (!data || data.running !== true) return { running: false, error: 'The Evolver Proxy answered but does not report itself running.' };
  return {
    running: true,
    pid: data.health?.pid ?? null,
    hub_mode: data.hub_mode ?? 'public',
    node_id: data.node_id ?? 'unclaimed',
    hub_auth: data.hub_auth_status ?? null,
    pending: { outbound: Number(data.outbound_pending ?? 0), inbound: Number(data.inbound_pending ?? 0) },
    last_sync: timeOf(data.last_sync_at),
    ...(data.last_sync_error && { last_sync_error: data.last_sync_error }),
  };
}

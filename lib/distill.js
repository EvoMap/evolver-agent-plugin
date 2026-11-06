// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// Without a host verifier the Proxy answers a draft and stores nothing, so the
// draft's Gene and Capsule are what the person later publishes or discards.
export function draftOf(result, { title, sessionId }, now) {
  const gene = result?.gene;
  const capsule = result?.capsule;
  if (result?.ok !== true || result.quality?.ok !== true || !result.distill_id || !gene?.asset_id || !capsule?.asset_id) return null;
  return {
    id: String(result.distill_id),
    title,
    summary: String(capsule.summary ?? gene.summary ?? ''),
    signals: Array.isArray(result.signals) ? result.signals : [],
    score: result.quality?.score ?? null,
    assets: [gene, capsule, ...(result.event ? [result.event] : [])],
    ...(typeof result.publishable === 'boolean' && { publishable: result.publishable }),
    ...(result.publish_receipt && { publish_receipt: result.publish_receipt }),
    sessionId,
    createdAt: now,
  };
}

export function skipReasonOf(result) {
  if (result?.ok !== true) return String(result?.reason ?? 'skipped');
  if (result.quality?.ok !== true) return String(result.quality?.reason ?? 'quality_gate');
  return 'incomplete_draft';
}

export function withDraft(drafts, draft) {
  const kept = (Array.isArray(drafts) ? drafts : []).filter((existing) => existing.id !== draft.id);
  return [...kept, draft];
}

export function withoutDraft(drafts, id) {
  return (Array.isArray(drafts) ? drafts : []).filter((draft) => draft.id !== id);
}

// `1` names the first listed draft; anything else is matched as an id prefix
// so a copied id works too.
export function draftNamed(drafts, selector) {
  const wanted = String(selector ?? '').trim();
  if (!wanted) return null;
  const list = Array.isArray(drafts) ? drafts : [];
  if (/^\d+$/.test(wanted)) return list[Number(wanted) - 1] ?? null;
  const matches = list.filter((draft) => draft.id.startsWith(wanted));
  return matches.length === 1 ? matches[0] : null;
}

export function reverifiedOf(result) {
  const assets = result?.assets;
  const receipt = result?.publish_receipt;
  if (result?.ok !== true || result.publishable !== true || !Array.isArray(assets) || assets.length < 2 || assets.length > 3) return null;
  if (!assets.every((asset) => asset && ['Gene', 'Capsule', 'EvolutionEvent'].includes(asset.type) && typeof asset.asset_id === 'string' && asset.asset_id)) return null;
  if (assets.filter((asset) => asset.type === 'Gene').length !== 1 || assets.filter((asset) => asset.type === 'Capsule').length !== 1) return null;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  return { assets, publish_receipt: receipt, publishable: true };
}

export function submitRequestOf(draft) {
  return {
    method: 'POST',
    path: '/asset/submit',
    body: { assets: draft.assets, ...(draft.publish_receipt && { publish_receipt: draft.publish_receipt }), request_id: `evolver-agent-plugin.draft.${draft.id}`.slice(0, 128) },
  };
}

export function draftsListText(drafts) {
  const list = Array.isArray(drafts) ? drafts : [];
  if (list.length === 0) return 'No distilled drafts are waiting.';
  const lines = list.map((draft, index) => `${index + 1}. ${draft.title} (${draft.id.slice(0, 12)}) — ${draft.summary}`);
  return [
    `${list.length} distilled draft${list.length === 1 ? '' : 's'} waiting for review:`,
    ...lines,
    'Publish one to the EvoMap Hub with `/evolver-drafts publish <number>`, or drop it with `/evolver-drafts discard <number>`.',
  ].join('\n');
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

/** @typedef {Record<string, { turn: number, injectedAt: number, strategyText?: string, reportedAt?: number }>} Ledger */

const ENTRY_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

/** @returns {Ledger} */
function pruned(ledger, now) {
  return Object.fromEntries(Object.entries(ledger ?? {}).filter(([, entry]) => {
    const at = Number(entry?.injectedAt);
    return Number.isFinite(at) && now - at <= ENTRY_PRUNE_MS;
  }));
}

/** @returns {Ledger} */
export function withInjected(ledger, assetId, { turn, strategyText }, now) {
  const kept = pruned(ledger, now);
  if (kept[assetId]) return kept;
  return { ...kept, [assetId]: { turn, injectedAt: now, strategyText } };
}

export function unreportedAssets(ledger, turn) {
  return Object.entries(ledger ?? {})
    .filter(([, entry]) => !entry?.reportedAt && Number(entry?.turn) <= turn)
    .map(([assetId, entry]) => ({ assetId, strategyText: entry.strategyText ?? '' }));
}

/** @returns {Ledger} */
export function withReported(ledger, assetIds, now) {
  const kept = pruned(ledger, now);
  for (const assetId of assetIds) if (kept[assetId]) kept[assetId] = { ...kept[assetId], reportedAt: now };
  return kept;
}

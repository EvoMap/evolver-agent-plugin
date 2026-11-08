// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The reuse estimator of @evomap/evolver-core's savingsCore (spec 0.3.0), so a
// figure shown here reads the same as the EvoMap ledger's. An injected strategy
// is a reference reuse: the model still writes the code, so only a fraction of
// deriving the approach from scratch is counted.
export const SAVINGS_SPEC_VERSION = '0.3.0';

const DERIVE_BASE_TOKENS = 120_000;
const TOKENS_PER_CHANGED_LINE = 800;
const DERIVE_CAP_TOKENS = 600_000;
const TYPICAL_CHANGED_LINES = 75;
const REFERENCE_SAVING_FRACTION = 0.4;
const USD_PER_M_TOKENS_BLENDED = 9;

export function referenceReuseSavings(changedLines) {
  const isMeasured = Number.isFinite(changedLines) && changedLines > 0;
  const lines = isMeasured ? changedLines : TYPICAL_CHANGED_LINES;
  const derived = Math.min(DERIVE_BASE_TOKENS + lines * TOKENS_PER_CHANGED_LINE, DERIVE_CAP_TOKENS);
  const tokens = Math.round(derived * REFERENCE_SAVING_FRACTION);
  return {
    tokens,
    usd: usdOf(tokens),
    basis: isMeasured ? 'estimated_blast_radius' : 'estimated_default',
  };
}

export function usdOf(tokens) {
  return Math.round((tokens / 1_000_000) * USD_PER_M_TOKENS_BLENDED * 100) / 100;
}

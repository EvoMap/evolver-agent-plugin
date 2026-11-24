// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { verdictOf } from './checks.js';
import { referenceReuseSavings, usdOf } from './savings.js';

const NAME_MAX_CHARS = 48;
const ASSET_ID_HEX_CHARS = 8;
const NO_EVIDENCE_TIER = 'none';

function compactTokens(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

// Cache reads are the context replayed on every step at a tenth of the price;
// counting them would report a long session's context, not this turn's work.
function freshTokens(usage) {
  if (!usage) return null;
  const counted = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens']
    .map((field) => Number(usage[field]))
    .filter(Number.isFinite);
  return counted.length === 0 ? null : counted.reduce((sum, value) => sum + value, 0);
}

const shortIdOf = (assetId) => {
  const match = /^sha256:([0-9a-f]+)$/.exec(String(assetId ?? ''));
  return match ? `sha256:${match[1].slice(0, ASSET_ID_HEX_CHARS)}` : null;
};

function strategyLabelOf({ name, assetId }) {
  const shortId = shortIdOf(assetId);
  return `"${String(name).slice(0, NAME_MAX_CHARS)}"${shortId ? ` (${shortId})` : ''}`;
}

function injectedPart(reused) {
  const labels = reused.map(strategyLabelOf).join(', ');
  return reused.length === 1 ? `Evolver · injected ${labels}` : `Evolver · injected ${reused.length} strategies: ${labels}`;
}

// What the turn's last check says of the injected strategy's use. Without one, nothing shows the strategy helped.
function checkPart(lastCheck) {
  if (!lastCheck) return 'no check ran, so its use is unverified';
  const label = lastCheck.label || lastCheck.command;
  const verdict = verdictOf(lastCheck);
  if (verdict === 'unknown') return `? last check result unknown: ${label}`;
  return verdict === 'failed' ? `✗ last check failed: ${label}` : `✓ last check passed: ${label}`;
}

// What EvoMap was told, as the queued reports say it: a report with no check behind it carries no evidence.
function reportedPart(reused) {
  const reports = reused.filter((strategy) => strategy.outcome);
  if (reports.length === 0) return null;
  const outcomes = [...new Set(reports.map((report) => report.outcome))].join('/');
  const isUnevidenced = reports.every((report) => report.tier === NO_EVIDENCE_TIER);
  return `reported to EvoMap as ${outcomes}${isUnevidenced ? ' without evidence' : ''}`;
}

// A saving is claimed only for a reuse a passing check vouched for, and never
// above what the turn itself spent: the estimator prices deriving a whole
// approach from scratch, which a single answered question never cost.
function savedPart({ lastCheck, changedLines, usage }) {
  const used = freshTokens(usage);
  if (verdictOf(lastCheck) !== 'passed' || used === null) return null;
  const saved = Math.min(referenceReuseSavings(changedLines).tokens, used);
  return `est. ~${compactTokens(saved)} tokens saved (≈$${usdOf(saved).toFixed(2)})`;
}

/**
 * One line, shown only for a turn a strategy was injected into: the desktop draws it as a notice that renders no
 * line breaks. It names each strategy and its asset id, what the last check says of its use, what EvoMap was told,
 * and, only behind a passing check, the estimated saving. `reused` holds `{ name, assetId?, outcome?, tier? }`.
 */
export function turnSummaryOf({ reused = [], lastCheck, changedLines = 0, usage } = {}) {
  if (reused.length === 0) return null;
  return [injectedPart(reused), checkPart(lastCheck), reportedPart(reused), savedPart({ lastCheck, changedLines, usage })]
    .filter(Boolean).join(' · ');
}

const STRATEGY_NAME = /^\[Evolution Memory\] (.+?) \(EvoMap network\):/;
const strategyNameOf = (strategy) => STRATEGY_NAME.exec(String(strategy ?? ''))?.[1] ?? 'EvoMap strategy';

/**
 * The summary of a turn as it ended (`turnEnded`'s answer: its record, the strategies it reported and their reports,
 * in the same order), or null.
 */
export function endedTurnSummaryOf({ record, strategies, reports }, { usage } = {}) {
  return turnSummaryOf({
    reused: (strategies ?? []).map((strategy, index) => {
      const report = reports?.[index];
      return { name: strategyNameOf(strategy), assetId: report?.asset_id, outcome: report?.outcome, tier: report?.evidence?.tier };
    }),
    lastCheck: record?.checks?.at(-1),
    changedLines: record?.changedLines ?? 0,
    usage,
  });
}

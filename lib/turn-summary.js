// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { referenceReuseSavings, usdOf } from './savings.js';
import { outcomeOfReason } from './turn-outcomes.js';

const NAME_MAX_CHARS = 48;

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

function goalPart({ lastCheck, turnReason }) {
  if (!lastCheck) return outcomeOfReason(turnReason) === 'success' ? '✓ Goal reached' : null;
  const label = lastCheck.label || lastCheck.command;
  return lastCheck.failed
    ? `✗ Goal not reached (last check failed: ${label})`
    : `✓ Goal reached (last check passed: ${label})`;
}

// A saving is claimed only for a reuse a passing check vouched for, and never
// above what the turn itself spent: the estimator prices deriving a whole
// approach from scratch, which a single answered question never cost.
function savingOf({ lastCheck, changedLines, usage }) {
  const used = freshTokens(usage);
  if (!lastCheck || lastCheck.failed || used === null) return null;
  return Math.min(referenceReuseSavings(changedLines).tokens, used);
}

function savedPart(turn) {
  const saved = savingOf(turn);
  return saved === null ? null : `est. ~${compactTokens(saved)} tokens saved (≈$${usdOf(saved).toFixed(2)})`;
}

function usedPart(usage) {
  const used = freshTokens(usage);
  return used === null ? null : `this turn used ${compactTokens(used)} fresh tokens`;
}

// One line, shown only for a turn that reused a strategy: the desktop draws it
// as a notice that renders no line breaks. It says whether the goal was
// reached, judged by the last check as the reuse report is, and what the reuse
// is estimated to have saved; a part with nothing to say is left out.
export function turnSummaryOf(turn) {
  if (!turn?.reusedNames?.length) return null;
  const names = turn.reusedNames.map((name) => `"${String(name).slice(0, NAME_MAX_CHARS)}"`).join(', ');
  return [goalPart(turn), `reused EvoMap strategy ${names}`, savedPart(turn), usedPart(turn.usage)].filter(Boolean).join(' · ');
}

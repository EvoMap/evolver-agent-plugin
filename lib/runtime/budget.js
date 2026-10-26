// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// What is left of a host's hook timeout once this process has started and must still answer: the recall waits at
// most that long, so the hook always answers before the host gives up on it.
const ANSWER_MARGIN_MS = 1_500;
const MIN_WAIT_MS = 500;
// A recall slower than this rarely lands at all (the Hub's text recall takes 3–11 s and sometimes times out), and
// the person's prompt waits on it.
const MAX_RECALL_WAIT_MS = 6_000;

/** Milliseconds a recall may wait: what the agent's budget for `event` leaves, at most MAX_RECALL_WAIT_MS. */
export function waitBudgetOf(budgets, event, { lifetime, startedAt = Date.now(), now = Date.now() } = {}) {
  if (lifetime === 'resident') return MAX_RECALL_WAIT_MS;
  const budget = budgets?.[event];
  if (!Number.isFinite(budget)) return MIN_WAIT_MS;
  return Math.min(MAX_RECALL_WAIT_MS, Math.max(MIN_WAIT_MS, budget - ANSWER_MARGIN_MS - (now - startedAt)));
}

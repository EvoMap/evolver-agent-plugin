// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// What is left of a host's hook timeout once this process has started and must still answer: the recall waits at
// most that long, so the hook always answers before the host gives up on it.
const ANSWER_MARGIN_MS = 1_500;
const MIN_WAIT_MS = 500;
const RESIDENT_RECALL_WAIT_MS = 6_000;

/** Milliseconds the work of `event` may wait, from the agent's declared budgets; a resident process waits a fixed while. */
export function waitBudgetOf(budgets, event, { lifetime, startedAt = Date.now(), now = Date.now() } = {}) {
  if (lifetime === 'resident') return RESIDENT_RECALL_WAIT_MS;
  const budget = budgets?.[event];
  if (!Number.isFinite(budget)) return MIN_WAIT_MS;
  return Math.max(MIN_WAIT_MS, budget - ANSWER_MARGIN_MS - (now - startedAt));
}

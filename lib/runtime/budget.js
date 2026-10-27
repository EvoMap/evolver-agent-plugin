// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// What is left of a host's hook timeout once this process has started and must still answer: the recall waits at
// most that long, so the hook always answers before the host gives up on it.
const ANSWER_MARGIN_MS = 1_500;
const MIN_WAIT_MS = 500;
// A recall slower than this rarely lands at all (the Hub's text recall takes 3–11 s and sometimes times out), and
// the person's prompt waits on it.
const MAX_RECALL_WAIT_MS = 6_000;

/**
 * Milliseconds a recall may wait: what the agent's budget for `event` leaves, at most MAX_RECALL_WAIT_MS. A resident
 * process starts no clock of its own, so its budget is the wait itself.
 */
export function waitBudgetOf(budgets, event, { lifetime, startedAt = Date.now(), now = Date.now() } = {}) {
  const budget = budgets?.[event];
  if (lifetime === 'resident') return Math.min(MAX_RECALL_WAIT_MS, budget ?? MAX_RECALL_WAIT_MS);
  if (!Number.isFinite(budget)) return MIN_WAIT_MS;
  return Math.min(MAX_RECALL_WAIT_MS, Math.max(MIN_WAIT_MS, budget - ANSWER_MARGIN_MS - (now - startedAt)));
}

// What a session-end hook needs besides its wait: Node's start, which its clock misses, then writing the last turn's
// reports and candidate and starting the worker (about 350 ms measured).
const SESSION_END_MARGIN_MS = 800;

/**
 * Milliseconds a session end may wait for the last turn's end (`settleMs`): within what the agent's `sessionEnd`
 * budget, its session-end hook timeout, leaves, where it names one.
 */
export function sessionEndWaitOf(budgets, settleMs, { startedAt = Date.now(), now = Date.now() } = {}) {
  const budget = budgets?.sessionEnd;
  if (!Number.isFinite(budget)) return settleMs;
  return Math.max(0, Math.min(settleMs, budget - SESSION_END_MARGIN_MS - (now - startedAt)));
}

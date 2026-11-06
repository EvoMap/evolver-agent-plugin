// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { checkIdentityOf, verdictOf } from '../checks.js';

// Whether a session's accumulated work is worth a model call, decided without one. Everyday chat never reaches here
// (it leaves no work turn); a few routine edits stay below the threshold until enough work piles up or an error gets
// fixed.

export const MIN_WORK_TURNS = 3;

export const GATE_REASONS = Object.freeze({
  NO_CHECK: 'no_check',
  LAST_TURN_UNCHECKED: 'last_turn_unchecked',
  LAST_CHECK_FAILED: 'last_check_failed',
  LAST_CHECK_UNKNOWN: 'last_check_unknown',
  TOO_LITTLE_WORK: 'too_little_work',
});

const stepsIn = (turns) => turns.flatMap((turn) => turn.steps);

/**
 * The checks of `turns` that failed, then saw files edited, then passed (`closed`, each a closed error episode, by
 * the check's identity: output trimming and redirects removed), and those whose latest run failed (`open`). A
 * failure followed by a pass with no edit between was no error the session fixed.
 */
export function errorEpisodesOf(turns) {
  const failing = new Map();
  const closed = [];
  for (const step of stepsIn(turns)) {
    if (step.kind === 'edit') {
      for (const failure of failing.values()) failure.edited = true;
      continue;
    }
    if (step.kind !== 'check') continue;
    const identity = checkIdentityOf(step.command);
    const verdict = verdictOf(step);
    if (verdict === 'failed' && !failing.has(identity)) failing.set(identity, { edited: false });
    if (verdict !== 'passed') continue;
    if (failing.get(identity)?.edited) closed.push(identity);
    failing.delete(identity);
  }
  return { closed, open: [...failing.keys()] };
}

const lastCheckOf = (turn) => turn?.steps.findLast((step) => step.kind === 'check');

function evidenceProblemOf(turns) {
  if (!stepsIn(turns).some((step) => step.kind === 'check' && verdictOf(step) !== 'unknown')) return GATE_REASONS.NO_CHECK;
  const last = lastCheckOf(turns.at(-1));
  if (!last) return GATE_REASONS.LAST_TURN_UNCHECKED;
  const verdict = verdictOf(last);
  if (verdict === 'failed') return GATE_REASONS.LAST_CHECK_FAILED;
  return verdict === 'unknown' ? GATE_REASONS.LAST_CHECK_UNKNOWN : null;
}

/**
 * The verdict on a session's work turns: `passed` when they hold at least MIN_WORK_TURNS turns or one closed error
 * episode, at least one check, and the last work turn's last check passed; else `reason`. A distillation the person
 * asks for (`needsAmount: false`) waives the amount, never the evidence.
 */
export function gateOf(turns, { needsAmount = true } = {}) {
  const facts = { workTurns: turns.length, episodes: errorEpisodesOf(turns).closed.length };
  const problem = evidenceProblemOf(turns);
  if (problem) return { ...facts, passed: false, reason: problem };
  if (needsAmount && facts.workTurns < MIN_WORK_TURNS && facts.episodes === 0) return { ...facts, passed: false, reason: GATE_REASONS.TOO_LITTLE_WORK };
  return { ...facts, passed: true, reason: null };
}

/** Whether `turns` end on a fixed error that has not failed again: an error episode is due once the session is quiet. */
export function isEpisodeReady(turns) {
  const { closed, open } = errorEpisodesOf(turns);
  return closed.length > 0 && !closed.some((identity) => open.includes(identity)) && gateOf(turns).passed;
}

const GATE_DETAILS = {
  [GATE_REASONS.NO_CHECK]: () => 'no test, build, lint or type-check ran',
  [GATE_REASONS.LAST_TURN_UNCHECKED]: () => 'the last work turn ran no check',
  [GATE_REASONS.LAST_CHECK_FAILED]: () => 'the last check failed',
  [GATE_REASONS.LAST_CHECK_UNKNOWN]: () => 'the last check\'s result is unknown',
  [GATE_REASONS.TOO_LITTLE_WORK]: ({ workTurns }) => `${workTurns} of ${MIN_WORK_TURNS} work turns and no fixed error`,
};

/** The gate's verdict in a few words, for the person. */
export const gateDetailOf = (gate) => GATE_DETAILS[gate.reason]?.(gate) ?? String(gate.reason);

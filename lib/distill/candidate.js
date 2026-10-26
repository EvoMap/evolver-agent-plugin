// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withoutSecrets } from '../redact.js';

// Distillation runs once a session, at its end, outside the conversation: each turn that finished verified only
// leaves a candidate, the latest one wins, and it is distilled once its session is over. These are the rules for
// that candidate, as functions over the table of pending candidates keyed by session id.

const PROMPT_MAX_CHARS = 6_000;
const ANSWER_MAX_CHARS = 3_000;
const COMMAND_MAX_CHARS = 300;
const MAX_COMMANDS = 40;
const MIN_COMMANDS_WITHOUT_EDITS = 3;
export const MAX_ATTEMPTS = 3;

/**
 * Why a finished turn leaves no candidate, or null when it does. Only work worth a Gene qualifies: a turn proved
 * by a check that passed last, which changed files or ran a few commands. A turn that reused an injected
 * strategy is distilled too: the engine's intake drops a Gene that repeats one it already has.
 */
export function skipReason(reason, record) {
  if (reason !== 'answer') return 'not_completed';
  if (!record.answer) return 'no_answer';
  const lastCheck = record.checks.at(-1);
  if (!lastCheck) return 'unverified';
  if (lastCheck.failed) return 'failed_check';
  if (record.edits.length === 0 && record.commands.length < MIN_COMMANDS_WITHOUT_EDITS) return 'too_little_work';
  return null;
}

// Keys and tokens are stripped before anything is written down or sent to a model or the Proxy.
export function candidateOf({ prompt, record, model, turn, pid, now }) {
  return {
    prompt: withoutSecrets(String(prompt ?? '')).slice(0, PROMPT_MAX_CHARS),
    commands: record.commands.slice(-MAX_COMMANDS).map((command) => withoutSecrets(command).slice(0, COMMAND_MAX_CHARS)),
    paths: [...new Set(record.paths)].map((file) => withoutSecrets(file)),
    checks: record.checks.map(({ command, failed }) => ({ command: withoutSecrets(command), failed })),
    answer: withoutSecrets(record.answer).slice(0, ANSWER_MAX_CHARS),
    model,
    turn,
    pid: pid ?? null,
    attempts: 0,
    at: now,
  };
}

export const withCandidate = (pending, sessionId, candidate) => ({ ...pending, [sessionId]: candidate });

function without(pending, sessionId) {
  const { [sessionId]: removed, ...rest } = pending;
  return rest;
}

export const withoutCandidate = (pending, sessionId) => (sessionId in pending ? without(pending, sessionId) : undefined);

export const withoutTurnCandidate = (pending, sessionId, turn) => (pending[sessionId]?.turn === turn ? without(pending, sessionId) : undefined);

/** A session that ended keeps its candidate due, so a distillation that failed at its end is tried again. */
export const withClosedCandidate = (pending, sessionId) =>
  (pending[sessionId] ? { ...pending, [sessionId]: { ...pending[sessionId], closed: true } } : undefined);

/** Whether `candidate` is still the session's: not dropped by a correction, nor replaced by a newer turn. */
export const isCurrentCandidate = (pending, sessionId, candidate) => pending[sessionId]?.at === candidate.at;

const isHeldByOther = (candidate, pid, isGone) => Boolean(candidate.claimedBy) && candidate.claimedBy !== pid && !isGone(candidate.claimedBy);

/** The session's own candidate claimed for `pid`; none when there is none or a live process distills it. */
export function claimedOwn(pending, sessionId, { pid, isGone }) {
  const candidate = pending[sessionId];
  if (!candidate || isHeldByOther(candidate, pid, isGone)) return { next: undefined, claimed: null };
  const claimed = { ...candidate, claimedBy: pid };
  return { next: { ...pending, [sessionId]: claimed }, claimed: { sessionId, candidate: claimed } };
}

// Over means ended, or killed with its owner; an idle session whose process still runs keeps its candidate.
function isLeftover(candidate, isGone) {
  const isOver = Boolean(candidate?.closed) || isGone(candidate?.pid);
  return isOver && (!candidate?.claimedBy || isGone(candidate.claimedBy));
}

/** The candidates of sessions that are over, claimed for `pid` at once, so two processes cannot distill one twice. */
export function claimedLeftovers(pending, { pid, isGone }) {
  const next = { ...pending };
  const claimed = [];
  for (const [sessionId, candidate] of Object.entries(pending)) {
    if (!isLeftover(candidate, isGone) || candidate.claimedBy === pid) continue;
    next[sessionId] = { ...candidate, claimedBy: pid };
    claimed.push({ sessionId, candidate: next[sessionId] });
  }
  return { next: claimed.length > 0 ? next : undefined, claimed };
}

/**
 * Removes a candidate once `done`, or counts a failed try and gives up after MAX_ATTEMPTS; a try that is not
 * `counted` only releases the claim. A newer candidate written meanwhile is left alone.
 */
export function settledCandidate(pending, sessionId, candidate, { done, counted }) {
  const current = pending[sessionId];
  if (!current || current.at !== candidate.at) return undefined;
  const attempts = (current.attempts ?? 0) + (counted ? 1 : 0);
  if (done || attempts >= MAX_ATTEMPTS) return without(pending, sessionId);
  return { ...pending, [sessionId]: { ...current, attempts, claimedBy: null } };
}

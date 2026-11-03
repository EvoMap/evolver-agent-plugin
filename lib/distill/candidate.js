// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { checkExitOf, verdictOf } from '../checks.js';
import { withoutSecrets } from '../redact.js';

// Distillation runs outside the conversation: each turn that finished verified only leaves a candidate, the latest
// one wins, and it is distilled once its session is over or has gone quiet. These are the rules for that candidate,
// as functions over the table of pending candidates keyed by session id.

const PROMPT_MAX_CHARS = 6_000;
const ANSWER_MAX_CHARS = 3_000;
const COMMAND_MAX_CHARS = 300;
const MAX_COMMANDS = 40;
const MIN_COMMANDS_WITHOUT_EDITS = 3;
export const MAX_ATTEMPTS = 3;
// With no model outside the conversation, a leftover waits this long for an agent to write its Gene from a
// command, and is then dropped.
export const UNDISTILLED_LEFTOVER_TTL_MS = 24 * 60 * 60 * 1000;
// A session quiet this long after its candidate had the person's chance to correct it: a correction drops the
// candidate at the next prompt, and a desktop session may run for days without ending.
export const IDLE_DISTILL_MS = 30 * 60 * 1000;
// A failed background try waits RETRY_BASE_MS × 2^(attempts − 1), at most RETRY_MAX_MS, before the next one: every
// hook event would otherwise retry a due candidate at once and use up its tries within a minute.
export const RETRY_BASE_MS = 10 * 60 * 1000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;
export const TRIGGERS = Object.freeze({ SESSION_END: 'session_end', IDLE: 'idle' });

/**
 * Why a finished turn leaves no candidate, or null when it does. Only work worth a Gene qualifies: a turn proved
 * by a check that passed last, which changed files or ran a few commands. A turn that reused an injected
 * strategy is distilled too: the engine's intake drops a Gene that repeats one it already has.
 */
export function skipReason(reason, record) {
  if (reason !== 'answer') return 'not_completed';
  if (!record.answer) return 'no_answer';
  const lastCheck = record.checks.at(-1);
  const verdict = verdictOf(lastCheck);
  if (verdict === 'failed') return 'failed_check';
  if (verdict === 'unknown') return 'unverified';
  if (record.edits.length === 0 && record.commands.length < MIN_COMMANDS_WITHOUT_EDITS) return 'too_little_work';
  return null;
}

// Keys and tokens are stripped before anything is written down or sent to a model or the Proxy. `source` says who
// saw the checks run (OBSERVED by the host, AGENT_REPORTED by the agent), and `project` is the git work tree they ran
// in, whose diff its snapshot has already left out when it touches a secret.
export function candidateOf({ prompt, record, model, turn, pid, now, source, project = null }) {
  return {
    prompt: withoutSecrets(String(prompt ?? '')).slice(0, PROMPT_MAX_CHARS),
    commands: record.commands.slice(-MAX_COMMANDS).map((command) => withoutSecrets(command).slice(0, COMMAND_MAX_CHARS)),
    paths: [...new Set(record.paths)].map((file) => withoutSecrets(file)),
    checks: record.checks.map(({ command, exit, failed }) => ({ command: withoutSecrets(command), exit: checkExitOf({ exit, failed }), failed })),
    source,
    ...(project && { project }),
    answer: withoutSecrets(record.answer).slice(0, ANSWER_MAX_CHARS),
    model,
    turn,
    pid: pid ?? null,
    attempts: 0,
    at: now,
  };
}

export const withCandidate = (pending, sessionId, candidate) => ({ ...pending, [sessionId]: candidate });

/**
 * The session's candidate judged again on its whole turn: a candidate already written for that turn keeps its stamp,
 * tries and claim, so a Gene requested for it, or a distillation running on it, still counts.
 */
export function withRejudgedCandidate(pending, sessionId, candidate) {
  const current = pending[sessionId];
  if (current?.turn !== candidate.turn) return withCandidate(pending, sessionId, candidate);
  return { ...pending, [sessionId]: { ...current, ...candidate, at: current.at, attempts: current.attempts } };
}

/** The session of the newest candidate, or of the one stamped `at`; null when there is none. */
export function candidateSessionOf(pending, { at } = {}) {
  const entries = Object.entries(pending ?? {});
  if (at !== undefined) return entries.find(([, candidate]) => candidate?.at === at)?.[0] ?? null;
  return entries.sort(([, left], [, right]) => (right?.at ?? 0) - (left?.at ?? 0))[0]?.[0] ?? null;
}

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

const isHeld = (candidate, isGone) => Boolean(candidate.claimedBy) && !isGone(candidate.claimedBy);

/** The session's own candidate claimed for `pid`; none when there is none or a live process distills it. */
export function claimedOwn(pending, sessionId, { pid, isGone }) {
  const candidate = pending[sessionId];
  if (!candidate || isHeld(candidate, isGone)) return { next: undefined, claimed: null };
  const claimed = { ...candidate, claimedBy: pid };
  return { next: { ...pending, [sessionId]: claimed }, claimed: { sessionId, candidate: claimed } };
}

// Over means ended, or killed with its owner.
const isOver = (candidate, isGone) => Boolean(candidate?.closed) || isGone(candidate?.pid);
const isUnclaimed = (candidate, isGone) => !candidate?.claimedBy || isGone(candidate.claimedBy);
const lastActiveAt = (candidate) => candidate?.activeAt ?? candidate?.at;
const isQuiet = (candidate, now) => Boolean(candidate?.quiet) || now - Number(lastActiveAt(candidate)) >= IDLE_DISTILL_MS;
const isLeftover = (candidate, isGone) => isOver(candidate, isGone) && isUnclaimed(candidate, isGone);
const isRetryDue = (candidate, now) => !(now < Number(candidate?.retryAt));
const isDue = (candidate, { now, isGone }) =>
  (isOver(candidate, isGone) || isQuiet(candidate, now)) && isUnclaimed(candidate, isGone) && isRetryDue(candidate, now);

/**
 * The session did something since its candidate (a prompt that was no correction, a turn that left none): the quiet
 * wait starts again, unless the session had already been quiet long enough, which this keeps for the candidate.
 */
export function withSessionActivity(pending, sessionId, now) {
  const candidate = pending[sessionId];
  if (!candidate || candidate.quiet) return undefined;
  const marked = isQuiet(candidate, now) ? { quiet: true } : { activeAt: now };
  return { ...pending, [sessionId]: { ...candidate, ...marked } };
}

/** Whether a candidate waits to be distilled: its session is over or quiet, and no live process distills it. */
export const hasDueCandidate = (pending, { now, isGone }) => Object.values(pending ?? {}).some((candidate) => isDue(candidate, { now, isGone }));

/**
 * The due candidates, claimed for `pid` at once, so two processes cannot distill one twice; each with the `trigger`
 * that made it due.
 */
export function claimedDue(pending, { pid, isGone, now }) {
  const next = { ...pending };
  const claimed = [];
  for (const [sessionId, candidate] of Object.entries(pending)) {
    if (!isDue(candidate, { now, isGone }) || candidate.claimedBy === pid) continue;
    next[sessionId] = { ...candidate, claimedBy: pid };
    claimed.push({ sessionId, candidate: next[sessionId], trigger: isOver(candidate, isGone) ? TRIGGERS.SESSION_END : TRIGGERS.IDLE });
  }
  return { next: claimed.length > 0 ? next : undefined, claimed };
}

/** The table without leftovers older than UNDISTILLED_LEFTOVER_TTL_MS; undefined when none is. */
export function withoutExpiredLeftovers(pending, { now, isGone }) {
  const isExpired = (candidate) => isLeftover(candidate, isGone) && now - Number(candidate?.at) > UNDISTILLED_LEFTOVER_TTL_MS;
  const kept = Object.entries(pending).filter(([, candidate]) => !isExpired(candidate));
  return kept.length < Object.keys(pending).length ? Object.fromEntries(kept) : undefined;
}

const retryDelayOf = (attempts) => Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);

/**
 * Removes a candidate once `done`, or counts a failed try, puts the next background try off (`retryAt`) and gives
 * up after MAX_ATTEMPTS; a try that is not `counted` only releases the claim. A newer candidate written meanwhile is
 * left alone.
 */
export function settledCandidate(pending, sessionId, candidate, { done, counted, now }) {
  const current = pending[sessionId];
  if (!current || current.at !== candidate.at) return undefined;
  const attempts = (current.attempts ?? 0) + (counted ? 1 : 0);
  if (done || attempts >= MAX_ATTEMPTS) return without(pending, sessionId);
  const retry = counted ? { retryAt: now + retryDelayOf(attempts) } : {};
  return { ...pending, [sessionId]: { ...current, attempts, claimedBy: null, ...retry } };
}

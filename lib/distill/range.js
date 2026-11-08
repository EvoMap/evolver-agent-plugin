// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { verdictOf } from '../checks.js';
import { isEpisodeReady } from './gate.js';
import { stepsOf } from './work-turn.js';

// Distillation runs outside the conversation, on what a session did since its last distillation: its range of work
// turns, kept in a table keyed by session id. These are the rules for that table. A range is distilled once its
// session is over, has been quiet IDLE_DISTILL_MS, or EPISODE_QUIET_MS after it fixed an error; whether it is worth a
// model call then is the gate's (lib/distill/gate.js).

export const MAX_ATTEMPTS = 3;
// With no model outside the conversation, a leftover waits this long for an agent to write its Gene from a
// command, and is then dropped.
export const UNDISTILLED_LEFTOVER_TTL_MS = 24 * 60 * 60 * 1000;
export const BLOCKED_ROUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const IDLE_DISTILL_MS = 30 * 60 * 1000;
export const EPISODE_QUIET_MS = 10 * 60 * 1000;
// A failed background try waits RETRY_BASE_MS × 2^(attempts − 1), at most RETRY_MAX_MS, before the next one: every
// hook event would otherwise retry a due range at once and use up its tries within a minute.
export const RETRY_BASE_MS = 10 * 60 * 1000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;
const MAX_RANGE_TURNS = 20;
export const TRIGGERS = Object.freeze({ SESSION_END: 'session_end', IDLE: 'idle', ERROR_EPISODE: 'error_episode' });

// Native capture binds the normalized model route, config revision and credential together in this digest.
const bindingOf = (model) => typeof model?.binding === 'string' && model.binding ? model.binding : null;
const isNativeRange = (range) => Boolean(range.native || bindingOf(range.model));

// A candidate an earlier version left holds one verified turn: it becomes a range of that turn, for the gate to judge.
function migrated(entry) {
  if (!entry || Array.isArray(entry.turns)) return entry;
  const { prompt, commands = [], paths = [], checks = [], answer, turn, project, quiet, sessionEpoch, finalizationPending, ...kept } = entry;
  const steps = stepsOf({ checks, commands, edits: paths });
  const base = project?.head ? { root: project.root, head: project.head } : null;
  const binding = bindingOf(entry.model);
  const workTurn = {
    turn: turn ?? 1, prompt: prompt ?? '', steps, answer: answer ?? '', at: entry.at,
    ...(sessionEpoch !== undefined && { sessionEpoch }), ...(finalizationPending && { finalizationPending: true }),
    ...(binding && { modelBinding: binding }),
  };
  return { ...kept, sessionEpoch, turns: [workTurn], base, project: project ?? null, changedAt: entry.at, ...(quiet && { dueBy: TRIGGERS.IDLE }) };
}

/** The session's range, as this version keeps it; null when it has none. */
export const rangeOf = (pending, sessionId) => migrated(pending?.[sessionId]) ?? null;
const rangesOf = (pending) => Object.entries(pending ?? {}).map(([sessionId, entry]) => [sessionId, migrated(entry)]);

/** Before prompting or posting, require one captured native binding across all work in the range. */
export function rangeRouteProblem(range, { requireCapturedRoute = false } = {}) {
  if (!(requireCapturedRoute || isNativeRange(range))) return null;
  if (range.routeConflict) return range.routeConflict;
  const binding = bindingOf(range.model);
  const epochs = new Set(range.turns.map((turn) => turn.sessionEpoch).filter((epoch) => epoch != null));
  if (epochs.size > 1 || (binding && range.turns.some((turn) => turn.modelBinding && turn.modelBinding !== binding))) return 'route_changed';
  return binding && range.turns.every((turn) => turn.modelBinding === binding) ? null : 'route_not_captured';
}

const lastActiveAt = (range) => Number(range.activeAt ?? range.changedAt ?? range.at);

// `changedAt` names the turns as an IR was asked for (an agent's `writtenFor`), so two changes never share it.
const changedAtAfter = (range, now) => Math.max(now, Number(range.changedAt ?? 0) + 1);

function timedTriggerOf(range, now) {
  const quietFor = now - lastActiveAt(range);
  if (quietFor >= EPISODE_QUIET_MS && isEpisodeReady(range.turns)) return TRIGGERS.ERROR_EPISODE;
  return quietFor >= IDLE_DISTILL_MS && !range.held ? TRIGGERS.IDLE : null;
}

// Something happened in the session: the quiet wait starts again, unless the range was due already, which it stays.
function withActivity(range, now) {
  if (range.dueBy) return range;
  const due = timedTriggerOf(range, now);
  return due ? { ...range, dueBy: due } : { ...range, activeAt: now };
}

function matchingTurn(turns, turnNumber, sessionEpoch) {
  const matches = turns.filter((turn) => turn.turn === turnNumber);
  if (sessionEpoch !== undefined) {
    return matches.find((turn) => turn.sessionEpoch === sessionEpoch)
      ?? (matches.length === 1 && matches[0].sessionEpoch === undefined ? matches[0] : undefined);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/** Where the range's diff is taken from once `workTurn` joins it: the HEAD its first kept turn began on. */
export function baseFor(pending, sessionId, workTurn) {
  const range = rangeOf(pending, sessionId);
  if (!range) return workTurn.head ?? null;
  if (!isNativeRange(range) && range.sessionEpoch !== workTurn.sessionEpoch) return workTurn.head ?? null;
  if (workTurn.sessionEpoch != null && range.turns.some((turn) => turn.sessionEpoch != null && turn.sessionEpoch !== workTurn.sessionEpoch)) return workTurn.head ?? null;
  const isReplacing = Boolean(matchingTurn(range.turns, workTurn.turn, workTurn.sessionEpoch));
  const dropsFirst = !isReplacing && range.turns.length >= MAX_RANGE_TURNS;
  return dropsFirst ? (range.turns[1].head ?? range.base) : range.base;
}

function joinedTurns(turns, workTurn) {
  const known = matchingTurn(turns, workTurn.turn, workTurn.sessionEpoch);
  const merged = known ? {
    ...workTurn, at: known.at, ...(known.correction && { correction: known.correction }),
    ...(Object.hasOwn(known, 'modelBinding') && { modelBinding: known.modelBinding }),
  } : workTurn;
  return [...turns.filter((turn) => turn !== known), merged].sort((left, right) =>
    left.sessionEpoch === right.sessionEpoch ? left.turn - right.turn : left.at - right.at);
}

/**
 * The table with `workTurn` in the session's range: added, or in place of the same turn judged again (keeping its
 * correction). `context` is `{ base, project, projectDir, model, pid, source, native, now }`: the range's diff base and the
 * project snapshot taken against it at this turn's end, and who runs the session.
 */
export function withWorkTurn(pending, sessionId, workTurn, { now, native, beforeNewerTurn, ...context }) {
  const range = rangeOf(pending, sessionId);
  const nativeRange = Boolean(native || bindingOf(context.model) || (range && isNativeRange(range)));
  const turn = nativeRange ? { ...workTurn, modelBinding: bindingOf(context.model) } : workTurn;
  if (!range || (!nativeRange && range.sessionEpoch !== context.sessionEpoch)) {
    return { ...pending, [sessionId]: { turns: [turn], ...context, ...(nativeRange && { native: true }), at: now, changedAt: now, activeAt: now, attempts: 0 } };
  }
  const turns = joinedTurns(range.turns, turn);
  const retained = turns.slice(-MAX_RANGE_TURNS);
  if (beforeNewerTurn && !matchingTurn(retained, turn.turn, turn.sessionEpoch)) return undefined;
  // A delayed work turn retains the newer turn's route and snapshot, unless it changes the snapshot's base.
  const first = range.turns[0];
  const changes = !beforeNewerTurn ? context
    : workTurn.turn < first.turn && JSON.stringify(workTurn.head ?? null) !== JSON.stringify(range.base ?? null)
      ? { base: workTurn.head ?? null, project: null } : {};
  const next = { ...withActivity(range, now), turns, ...changes, changedAt: changedAtAfter(range, now), held: false };
  if (nativeRange) {
    next.native = true;
    // Keep the block if a conflicting source turn rolls out. Its diff may still span that turn.
    const problem = rangeRouteProblem(range, { requireCapturedRoute: true }) ?? rangeRouteProblem(next);
    if (problem) {
      next.routeConflict = problem;
      next.blocked = { reason: problem, at: range.blocked ? blockedAtOf(range) : now };
    }
  } else delete next.blocked;
  next.turns = retained;
  return { ...pending, [sessionId]: next };
}

/** The table without that turn of the session's range (judged again, it was no work); no range is left empty. */
export function withoutWorkTurn(pending, sessionId, turnNumber, { sessionEpoch, now = 0 } = {}) {
  const range = rangeOf(pending, sessionId);
  const removedTurn = range && matchingTurn(range.turns, turnNumber, sessionEpoch);
  if (!removedTurn) return undefined;
  const turns = range.turns.filter((turn) => turn !== removedTurn);
  if (turns.length > 0) {
    const modelIsCurrent = isNativeRange(range)
      ? turns.at(-1).modelBinding === bindingOf(range.model)
      : removedTurn !== range.turns.at(-1);
    const model = modelIsCurrent ? range.model : null;
    const base = range.turns[0] === removedTurn ? turns[0].head ?? null : range.base;
    const problem = rangeRouteProblem(range);
    return { ...pending, [sessionId]: { ...range, turns, base, project: null, model, changedAt: changedAtAfter(range, now), ...(problem && { routeConflict: problem }) } };
  }
  const { [sessionId]: removed, ...rest } = pending;
  return rest;
}

/** The person's next prompt corrected `turnNumber`: it stays in the range, with the correction as its last word. */
export function withCorrection(pending, sessionId, turnNumber, text, now, { sessionEpoch } = {}) {
  const range = rangeOf(pending, sessionId);
  const corrected = range && matchingTurn(range.turns, turnNumber, sessionEpoch);
  if (!text || !corrected) return undefined;
  if (corrected.finalizationPending) return withoutWorkTurn(pending, sessionId, turnNumber, { sessionEpoch, now });
  const turns = range.turns.map((turn) => (turn === corrected ? { ...turn, correction: text } : turn));
  return { ...pending, [sessionId]: { ...range, turns, changedAt: changedAtAfter(range, now) } };
}

export function withSessionActivity(pending, sessionId, now) {
  const range = rangeOf(pending, sessionId);
  if (!range || range.dueBy) return undefined;
  return { ...pending, [sessionId]: withActivity(range, now) };
}

/** A session that ended keeps its range due, so a distillation that failed at its end is tried again. */
export const withClosedRange = (pending, sessionId) =>
  (pending?.[sessionId] ? { ...pending, [sessionId]: { ...rangeOf(pending, sessionId), closed: true } } : undefined);

/** A native terminal can be known while one of its background checks still lacks a result. */
export function withPendingNativeCheck(pending, sessionId, { turn, sessionEpoch }, now) {
  const range = rangeOf(pending, sessionId);
  const check = range?.pendingNativeCheck;
  if (!range || range.sessionEpoch !== sessionEpoch || (check && check.sessionEpoch === sessionEpoch && check.turn >= turn)
    || range.turns.some((work) => work.sessionEpoch === sessionEpoch && work.turn > turn)) return undefined;
  return { ...pending, [sessionId]: { ...range, pendingNativeCheck: { turn, sessionEpoch }, changedAt: changedAtAfter(range, now) } };
}

export function withoutPendingNativeCheck(pending, sessionId, { turn, sessionEpoch }) {
  const range = rangeOf(pending, sessionId);
  const check = range?.pendingNativeCheck;
  if (!check || check.turn !== turn || check.sessionEpoch !== sessionEpoch) return undefined;
  const { pendingNativeCheck, ...rest } = range;
  return { ...pending, [sessionId]: rest };
}

const isOver = (range, isGone) => Boolean(range.closed) || isGone(range.pid);
const isUnclaimed = (range, isGone) => !range.claimedBy || isGone(range.claimedBy);
const isRetryDue = (range, now) => !(now < Number(range.retryAt));
const isRouteBlocked = (range) => Boolean(range.blocked && (range.model || range.routeConflict));
const isProvisional = (range) => (range.pendingNativeCheck && range.pendingNativeCheck.sessionEpoch === range.sessionEpoch)
  || range.turns.some((turn) => turn.finalizationPending);
const isFinalized = (range, requireCompletedChecks) => !isProvisional(range)
  && (!(requireCompletedChecks || isNativeRange(range)) || range.turns.every((turn) =>
    turn.steps.every((step) => step.kind !== 'check' || verdictOf(step) !== 'unknown')));

function blockedAtOf(range) {
  const at = range.blocked.at ?? range.at;
  return Number.isFinite(at) ? at : 0;
}

const blockedExpiryAt = (range) => blockedAtOf(range) + BLOCKED_ROUTE_TTL_MS;

function triggerOf(range, { now, isGone }) {
  if (isOver(range, isGone)) return TRIGGERS.SESSION_END;
  return range.dueBy ?? timedTriggerOf(range, now);
}

const isDue = (range, context) => !isRouteBlocked(range) && isFinalized(range, context.requireCompletedChecks)
  && isUnclaimed(range, context.isGone) && isRetryDue(range, context.now) && triggerOf(range, context) !== null;

/** Whether a range waits to be distilled: due by a trigger, and no live process distills it. */
export const hasDueRange = (pending, context) => rangesOf(pending).some(([, range]) => isDue(range, context));

function dueAtOf(range, context) {
  if (isRouteBlocked(range)) return isProvisional(range) ? null : blockedExpiryAt(range);
  if (context.includeDistillation === false || !isFinalized(range, context.requireCompletedChecks)) return null;
  const retryAt = Number(range.retryAt) || 0;
  if (triggerOf(range, context)) return retryAt;
  const since = lastActiveAt(range);
  const at = Math.min(isEpisodeReady(range.turns) ? since + EPISODE_QUIET_MS : Infinity, range.held ? Infinity : since + IDLE_DISTILL_MS);
  return Number.isFinite(at) ? Math.max(at, retryAt) : null;
}

/**
 * When the next range comes due, in epoch ms and never before `now`; null when none will without more work. One a
 * live process distills is left out: that process settles it and looks again.
 */
export function nextDueAt(pending, context) {
  const dueAts = rangesOf(pending)
    .filter(([, range]) => isUnclaimed(range, context.isGone))
    .map(([, range]) => dueAtOf(range, context))
    .filter((at) => at !== null);
  return dueAts.length > 0 ? Math.max(context.now, Math.min(...dueAts)) : null;
}

/** The due ranges, claimed for `pid` at once so two processes cannot distill one twice, each with its trigger. */
export function claimedDue(pending, { pid, ...context }) {
  const next = { ...pending };
  const claimed = [];
  for (const [sessionId, range] of rangesOf(pending)) {
    if (!isDue(range, context) || range.claimedBy === pid) continue;
    next[sessionId] = { ...range, claimedBy: pid };
    claimed.push({ sessionId, range: next[sessionId], trigger: triggerOf(range, context) });
  }
  return { next: claimed.length > 0 ? next : undefined, claimed };
}

/** The session's own range claimed for `pid`; none when there is none or a live process distills it. */
export function claimedOwn(pending, sessionId, { pid, isGone, requireCompletedChecks }) {
  const range = rangeOf(pending, sessionId);
  if (!range || !isFinalized(range, requireCompletedChecks) || !isUnclaimed(range, isGone)) return { next: undefined, claimed: null };
  const claimed = { ...range, claimedBy: pid };
  return { next: { ...pending, [sessionId]: claimed }, claimed: { sessionId, range: claimed } };
}

/** The session holding the newest range, or the range `isWanted(sessionId, range)` picks; null when there is none. */
export function rangeSessionOf(pending, isWanted = null) {
  const ranges = rangesOf(pending);
  if (isWanted) return ranges.find(([sessionId, range]) => isWanted(sessionId, range))?.[0] ?? null;
  return ranges.sort(([, left], [, right]) => (right.changedAt ?? 0) - (left.changedAt ?? 0))[0]?.[0] ?? null;
}

/** The table without leftovers older than UNDISTILLED_LEFTOVER_TTL_MS; undefined when none is. */
export function withoutExpiredLeftovers(pending, { now, isGone, blockedOnly = false }) {
  const isExpired = (range) => !isProvisional(range) && isUnclaimed(range, isGone) && (isRouteBlocked(range)
    ? now >= blockedExpiryAt(range)
    : !blockedOnly && isOver(range, isGone) && now - Number(range.changedAt ?? range.at) > UNDISTILLED_LEFTOVER_TTL_MS);
  const kept = rangesOf(pending).filter(([, range]) => !isExpired(range));
  return kept.length < Object.keys(pending ?? {}).length ? Object.fromEntries(kept) : undefined;
}

const isSameTurn = (left, right) => left.turn === right.turn && left.sessionEpoch === right.sessionEpoch;
const isSameRange = (range, claimed) => Boolean(range) && range.at === claimed.at && range.claimedBy === claimed.claimedBy
  && range.sessionEpoch === claimed.sessionEpoch && claimed.turns.some((read) => range.turns.some((turn) => isSameTurn(turn, read)));
const isAsRead = (turn, read) => isSameTurn(turn, read) && JSON.stringify(turn) === JSON.stringify(read);

/** Whether all the claimed work still exists as read, under the same claim. */
export function isCurrentRange(pending, sessionId, claimed, { exact = false } = {}) {
  const range = rangeOf(pending, sessionId);
  if (!isSameRange(range, claimed) || !isFinalized(range)) return false;
  if (exact && range.changedAt !== claimed.changedAt) return false;
  if (!claimed.turns.every((read) => range.turns.some((turn) => isAsRead(turn, read)))) return false;
  return range.turns.length !== claimed.turns.length || range.changedAt === claimed.changedAt;
}

const retryDelayOf = (attempts) => Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);

// The turns a distillation read are done with; turns added while it ran start the next range, whose diff is taken
// again from their own start at the next work turn's end.
function withoutConsumed(pending, sessionId, range, claimed, now) {
  const turns = range.turns.filter((turn) => !claimed.turns.some((read) => isAsRead(turn, read)));
  const { [sessionId]: removed, ...rest } = pending;
  if (turns.length === 0) return rest;
  const { retryAt, dueBy, claimedBy, held, blocked, ...kept } = range;
  return { ...rest, [sessionId]: { ...kept, turns, base: turns[0].head ?? null, project: null, at: now, changedAt: changedAtAfter(range, now), activeAt: now, attempts: 0 } };
}

/**
 * The table once a distillation of `claimed` ended: its turns `consume`d (done, refused for good, or given up after
 * MAX_ATTEMPTS counted tries); `hold` keeps a range below the threshold from coming due again until more work joins
 * it; a `counted` failure puts the next try off (`retryAt`); anything else only releases the claim. A range replaced
 * meanwhile is left alone.
 */
export function settledRange(pending, sessionId, claimed, { consume = false, hold = false, counted = false, blocked, now }) {
  const range = rangeOf(pending, sessionId);
  if (!isSameRange(range, claimed)) return undefined;
  const attempts = (range.attempts ?? 0) + (counted && !blocked ? 1 : 0);
  if (consume || attempts >= MAX_ATTEMPTS) return withoutConsumed(pending, sessionId, range, claimed, now);
  const retry = counted && !blocked ? { retryAt: now + retryDelayOf(attempts) } : {};
  const held = hold && range.changedAt === claimed.changedAt ? { held: true, dueBy: null } : {};
  const { blocked: previousBlock, ...active } = range;
  const reason = range.routeConflict ?? blocked;
  const block = reason === undefined ? previousBlock : reason && { reason, at: previousBlock ? blockedAtOf(range) : now };
  return { ...pending, [sessionId]: { ...active, attempts, claimedBy: null, ...retry, ...held, ...(block && { blocked: block }) } };
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

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
export const IDLE_DISTILL_MS = 30 * 60 * 1000;
export const EPISODE_QUIET_MS = 10 * 60 * 1000;
// A model route the session captured that is unavailable now (changed, or its credential gone) parks the range without
// costing a try, until that route works again or this long after it was first found blocked.
export const BLOCKED_ROUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A failed background try waits RETRY_BASE_MS × 2^(attempts − 1), at most RETRY_MAX_MS, before the next one: every
// hook event would otherwise retry a due range at once and use up its tries within a minute.
export const RETRY_BASE_MS = 10 * 60 * 1000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;
const MAX_RANGE_TURNS = 20;
export const TRIGGERS = Object.freeze({ SESSION_END: 'session_end', IDLE: 'idle', ERROR_EPISODE: 'error_episode' });

// A candidate an earlier version left holds one verified turn: it becomes a range of that turn, for the gate to judge.
function migrated(entry) {
  if (!entry || Array.isArray(entry.turns)) return entry;
  const { prompt, commands = [], paths = [], checks = [], answer, turn, project, quiet, ...kept } = entry;
  const steps = stepsOf({ checks, commands, edits: paths });
  const base = project?.head ? { root: project.root, head: project.head } : null;
  return { ...kept, turns: [{ turn: turn ?? 1, prompt: prompt ?? '', steps, answer: answer ?? '', at: entry.at }], base, project: project ?? null, changedAt: entry.at, ...(quiet && { dueBy: TRIGGERS.IDLE }) };
}

/** The session's range, as this version keeps it; null when it has none. */
export const rangeOf = (pending, sessionId) => migrated(pending?.[sessionId]) ?? null;
const rangesOf = (pending) => Object.entries(pending ?? {}).map(([sessionId, entry]) => [sessionId, migrated(entry)]);

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

const isOtherEpoch = (epoch, range) => epoch !== undefined && range.sessionEpoch !== undefined && epoch !== range.sessionEpoch;

/**
 * Where the range's diff is taken from once `workTurn` joins it: the HEAD its first kept turn began on; the turn's own
 * HEAD when the range is of another session epoch than the turn's (`sessionEpoch`).
 */
export function baseFor(pending, sessionId, workTurn, { sessionEpoch } = {}) {
  const range = rangeOf(pending, sessionId);
  if (!range || isOtherEpoch(sessionEpoch, range)) return workTurn.head ?? null;
  const isReplacing = range.turns.some((turn) => turn.turn === workTurn.turn);
  const dropsFirst = !isReplacing && range.turns.length >= MAX_RANGE_TURNS;
  return dropsFirst ? (range.turns[1].head ?? range.base) : range.base;
}

function joinedTurns(turns, workTurn) {
  const known = turns.find((turn) => turn.turn === workTurn.turn);
  const merged = known ? { ...workTurn, at: known.at, ...(known.correction && { correction: known.correction }) } : workTurn;
  return [...turns.filter((turn) => turn.turn !== workTurn.turn), merged].sort((left, right) => left.turn - right.turn).slice(-MAX_RANGE_TURNS);
}

// A session epoch is the time its state started over, so a turn of an older epoch ends after a newer one began only
// when its write was late: it must not replace the newer range.
const isOlderEpoch = (epoch, range) => Number.isFinite(epoch) && Number.isFinite(range?.sessionEpoch) && epoch < range.sessionEpoch;

/**
 * The table with `workTurn` in the session's range: added, or in place of the same turn judged again (keeping its
 * correction). `context` is `{ base, project, projectDir, model, sessionEpoch, pid, source, now }`: the range's diff
 * base and the project snapshot taken against it at this turn's end, and who runs the session. A turn of a newer
 * session epoch (its state started over, so its turn numbers did) starts a range of its own; its model route replaces
 * a blocked one. A late turn of an older epoch changes nothing.
 */
export function withWorkTurn(pending, sessionId, workTurn, { now, ...context }) {
  const range = rangeOf(pending, sessionId);
  if (isOlderEpoch(context.sessionEpoch, range)) return undefined;
  if (!range || range.sessionEpoch !== context.sessionEpoch) {
    return { ...pending, [sessionId]: { turns: [workTurn], ...context, at: now, changedAt: now, activeAt: now, attempts: 0 } };
  }
  const turns = joinedTurns(range.turns, workTurn);
  // A turn judged again after a later one joined carries an older route, snapshot and owner: only its own turn changes.
  if (range.turns.some((turn) => turn.turn > workTurn.turn)) {
    return { ...pending, [sessionId]: { ...withActivity(range, now), turns, changedAt: changedAtAfter(range, now), held: false } };
  }
  const { blocked, ...active } = withActivity(range, now);
  return { ...pending, [sessionId]: { ...active, turns, ...context, changedAt: changedAtAfter(range, now), held: false } };
}

/** The table without that turn of the session's range (judged again, it was no work); no range is left empty. */
export function withoutWorkTurn(pending, sessionId, turnNumber, { sessionEpoch } = {}) {
  const range = rangeOf(pending, sessionId);
  if (!range?.turns.some((turn) => turn.turn === turnNumber) || isOtherEpoch(sessionEpoch, range)) return undefined;
  const turns = range.turns.filter((turn) => turn.turn !== turnNumber);
  if (turns.length > 0) return { ...pending, [sessionId]: { ...range, turns } };
  const { [sessionId]: removed, ...rest } = pending;
  return rest;
}

/** The person's next prompt corrected `turnNumber`: it stays in the range, with the correction as its last word. */
export function withCorrection(pending, sessionId, turnNumber, text, now, { sessionEpoch } = {}) {
  const range = rangeOf(pending, sessionId);
  if (!text || !range?.turns.some((turn) => turn.turn === turnNumber) || isOtherEpoch(sessionEpoch, range)) return undefined;
  const turns = range.turns.map((turn) => (turn.turn === turnNumber ? { ...turn, correction: text } : turn));
  return { ...pending, [sessionId]: { ...range, turns, changedAt: changedAtAfter(range, now) } };
}

export function withSessionActivity(pending, sessionId, now) {
  const range = rangeOf(pending, sessionId);
  if (!range || range.dueBy) return undefined;
  return { ...pending, [sessionId]: withActivity(range, now) };
}

/** A session end closes its observed range or late final turn, never a resumed turn. */
export function withClosedRange(pending, sessionId, expected, ending) {
  const range = rangeOf(pending, sessionId);
  if (!range || (ending && (range.sessionEpoch !== ending.sessionEpoch
    || range.turns.some((turn) => turn.turn > ending.turn)))) return undefined;
  const hasEndingTurn = ending && range.turns.some((turn) => turn.turn === ending.turn);
  if (!hasEndingTurn && (!expected || range.at !== expected.at || range.sessionEpoch !== expected.sessionEpoch
    || !expected.turns.some((read) => range.turns.some((turn) => turn.turn === read.turn)))) return undefined;
  return { ...pending, [sessionId]: { ...range, closed: true } };
}

const isHeld = (range, isGone) => Boolean(range.claimedBy) && !isGone(range.claimedBy);
const isOver = (range, isGone) => Boolean(range.closed) || isGone(range.pid);
const isUnclaimed = (range, isGone) => !range.claimedBy || isGone(range.claimedBy);
const isRetryDue = (range, now) => !(now < Number(range.retryAt));
const isRouteBlocked = (range) => Boolean(range.blocked && range.model);

function blockedAtOf(range) {
  const at = range.blocked.at ?? range.at;
  return Number.isFinite(at) ? at : 0;
}

const blockedExpiryAt = (range) => blockedAtOf(range) + BLOCKED_ROUTE_TTL_MS;

function triggerOf(range, { now, isGone }) {
  if (isOver(range, isGone)) return TRIGGERS.SESSION_END;
  return range.dueBy ?? timedTriggerOf(range, now);
}

const isDue = (range, context) =>
  !isRouteBlocked(range) && isUnclaimed(range, context.isGone) && isRetryDue(range, context.now) && triggerOf(range, context) !== null;

/** Whether a range waits to be distilled: due by a trigger, and no live process distills it. */
export const hasDueRange = (pending, context) => rangesOf(pending).some(([, range]) => isDue(range, context));

function dueAtOf(range, context) {
  const retryAt = Number(range.retryAt) || 0;
  if (triggerOf(range, context)) return retryAt;
  const since = lastActiveAt(range);
  const at = Math.min(isEpisodeReady(range.turns) ? since + EPISODE_QUIET_MS : Infinity, range.held ? Infinity : since + IDLE_DISTILL_MS);
  return Number.isFinite(at) ? Math.max(at, retryAt) : null;
}

/**
 * When the next range comes due or a blocked route expires (only the latter without `includeDistillation`), in epoch
 * ms and never before `now`; null when none will without more work. One a live process distills is left out: that
 * process settles it and looks again.
 */
export function nextDueAt(pending, { includeDistillation = true, ...context }) {
  const dueAts = rangesOf(pending)
    .filter(([, range]) => (includeDistillation || isRouteBlocked(range)) && isUnclaimed(range, context.isGone))
    .map(([, range]) => (isRouteBlocked(range) ? blockedExpiryAt(range) : dueAtOf(range, context)))
    .filter((at) => at !== null);
  return dueAts.length > 0 ? Math.max(context.now, Math.min(...dueAts)) : null;
}

/** The due ranges, claimed for `pid` at once so two processes cannot distill one twice, each with its trigger. */
export function claimedDue(pending, { pid, isGone, now }) {
  const next = { ...pending };
  const claimed = [];
  for (const [sessionId, range] of rangesOf(pending)) {
    if (!isDue(range, { now, isGone }) || range.claimedBy === pid) continue;
    next[sessionId] = { ...range, claimedBy: pid };
    claimed.push({ sessionId, range: next[sessionId], trigger: triggerOf(range, { now, isGone }) });
  }
  return { next: claimed.length > 0 ? next : undefined, claimed };
}

/** The session's own range claimed for `pid`; none when there is none or a live process distills it. */
export function claimedOwn(pending, sessionId, { pid, isGone }) {
  const range = rangeOf(pending, sessionId);
  if (!range || isHeld(range, isGone)) return { next: undefined, claimed: null };
  const claimed = { ...range, claimedBy: pid };
  return { next: { ...pending, [sessionId]: claimed }, claimed: { sessionId, range: claimed } };
}

/** The session holding the newest range, or the range `isWanted(sessionId, range)` picks; null when there is none. */
export function rangeSessionOf(pending, isWanted = null) {
  const ranges = rangesOf(pending);
  if (isWanted) return ranges.find(([sessionId, range]) => isWanted(sessionId, range))?.[0] ?? null;
  return ranges.sort(([, left], [, right]) => (right.changedAt ?? 0) - (left.changedAt ?? 0))[0]?.[0] ?? null;
}

/**
 * The table without expired route blocks and, unless `blockedOnly`, without leftovers older than
 * UNDISTILLED_LEFTOVER_TTL_MS; undefined when none is.
 */
export function withoutExpiredLeftovers(pending, { now, isGone, blockedOnly = false }) {
  const isExpired = (range) => (isRouteBlocked(range)
    ? isUnclaimed(range, isGone) && now >= blockedExpiryAt(range)
    : !blockedOnly && isOver(range, isGone) && isUnclaimed(range, isGone) && now - Number(range.changedAt ?? range.at) > UNDISTILLED_LEFTOVER_TTL_MS);
  const kept = rangesOf(pending).filter(([, range]) => !isExpired(range));
  return kept.length < Object.keys(pending ?? {}).length ? Object.fromEntries(kept) : undefined;
}

// One made again in the same millisecond, after the turns a distillation read were done with, holds none of them.
const isSameRange = (range, claimed) => Boolean(range) && range.at === claimed.at && range.claimedBy === claimed.claimedBy
  && range.sessionEpoch === claimed.sessionEpoch && claimed.turns.some((read) => range.turns.some((turn) => turn.turn === read.turn));
// A turn judged again while a distillation ran (a background command finished) keeps its number, not what it holds.
const isAsRead = (turn, read) => turn.turn === read.turn && turn.correction === read.correction
  && JSON.stringify([turn.steps, turn.answer]) === JSON.stringify([read.steps, read.answer]);
const wasReadAsIs = (claimed, turn) => claimed.turns.some((read) => isAsRead(turn, read));

/**
 * Whether what a distillation of `claimed` read is still the session's work: the same range under the same claim, every
 * turn it read still in it, and none corrected or judged again since. Turns joining meanwhile change nothing it read,
 * unless `exact` asks for the range exactly as read (an agent's Gene was written for those turns alone).
 */
export function isCurrentRange(pending, sessionId, claimed, { exact = false } = {}) {
  const range = rangeOf(pending, sessionId);
  return isSameRange(range, claimed) && (!exact || range.changedAt === claimed.changedAt)
    && claimed.turns.every((read) => range.turns.some((turn) => isAsRead(turn, read)));
}

const retryDelayOf = (attempts) => Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);

// The turns a distillation read are done with; turns added or corrected while it ran start the next range, whose diff
// is taken again from their own start at the next work turn's end.
function withoutConsumed(pending, sessionId, range, claimed, now) {
  const turns = range.turns.filter((turn) => !wasReadAsIs(claimed, turn));
  const { [sessionId]: removed, ...rest } = pending;
  if (turns.length === 0) return rest;
  const { retryAt, dueBy, claimedBy, held, blocked, ...kept } = range;
  return { ...rest, [sessionId]: { ...kept, turns, base: turns[0].head ?? null, project: null, at: now, changedAt: now, activeAt: now, attempts: 0 } };
}

/**
 * The table once a distillation of `claimed` ended: its turns `consume`d (done, refused for good, or given up after
 * MAX_ATTEMPTS counted tries); `hold` keeps a range below the threshold from coming due again until more work joins
 * it; a `counted` failure puts the next try off (`retryAt`); `blocked` (the reason its model route is unavailable)
 * parks it, dated from its first block; anything else only releases the claim. A range replaced meanwhile is left
 * alone.
 */
export function settledRange(pending, sessionId, claimed, { consume = false, hold = false, counted = false, blocked = null, now }) {
  const range = rangeOf(pending, sessionId);
  if (!isSameRange(range, claimed)) return undefined;
  const attempts = (range.attempts ?? 0) + (counted ? 1 : 0);
  if (consume || attempts >= MAX_ATTEMPTS) return withoutConsumed(pending, sessionId, range, claimed, now);
  const retry = counted ? { retryAt: now + retryDelayOf(attempts) } : {};
  const held = hold && range.changedAt === claimed.changedAt ? { held: true, dueBy: null } : {};
  const { blocked: previous, ...rest } = range;
  const routeBlock = blocked && { reason: blocked, at: previous ? blockedAtOf(range) : now };
  return { ...pending, [sessionId]: { ...rest, attempts, claimedBy: null, ...retry, ...held, ...(routeBlock && { blocked: routeBlock }) } };
}

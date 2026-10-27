// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { unreportedAssets, withInjected, withReported } from '../injected-ledger.js';

// One session's state as plain data, and every change to it as a function from state to state. The turn counter
// outlives the session's end, so a resumed session never repeats a task id the Hub would take for a duplicate.

export const EMPTY_SESSION = Object.freeze({
  turn: 0, turnId: null, open: false, turnStart: null, prompt: '', isCommand: false, strategy: '',
  labelable: [], injected: {}, pid: null, startedUnder: null, settling: null, turnIds: [], correctedTurn: 0, shown: [],
});

const MAX_SHOWN = 50;

const MAX_TURN_IDS = 20;

// A turn end that died halfway leaves `settling` behind; past this age it no longer holds the next prompt up.
const SETTLING_STALE_MS = 30_000;

export const sessionOf = (stored) => ({ ...EMPTY_SESSION, ...stored });

/**
 * The session's next turn. A turn nobody typed a prompt for (`prompt` null) carries on the last turn's task. A host
 * that numbers its own turns (`hostTurn`) keeps the count at least there, so a session resumed after its state was
 * gone never repeats a task id.
 */
export function openedTurn(session, { turnId = null, turnStart = null, hostTurn = null, prompt = null, pid = null, isCommand = false }) {
  return {
    ...session,
    turn: Math.max(session.turn + 1, Number.isInteger(hostTurn) ? hostTurn : 0),
    turnId,
    turnIds: turnId ? [...session.turnIds.filter((known) => known !== turnId), turnId].slice(-MAX_TURN_IDS) : session.turnIds,
    open: true,
    turnStart,
    prompt: prompt ?? session.prompt,
    isCommand,
    strategy: '',
    pid: pid ?? session.pid,
    settling: null,
    labelable: isCommand ? session.labelable : [],
  };
}

const isOpenTurn = (session, turnId) => session.open && (!turnId || !session.turnId || turnId === session.turnId);

/**
 * The session with `turnId` (any turn when omitted) closed, and the turn as it was; `next` is undefined when none was
 * open. It stays `settling` until the turn's reports and candidate are written, so a prompt that arrives meanwhile
 * waits rather than labelling or dropping what is not there yet.
 */
export function closedTurn(session, turnId, now) {
  if (!isOpenTurn(session, turnId)) return { next: undefined, opened: null };
  return { next: { ...session, open: false, settling: now }, opened: session };
}

/** Whether the last turn is still closing: its reports and candidate are not all written yet. */
export const isSettling = (session, now) => Number.isFinite(session.settling) && now - session.settling < SETTLING_STALE_MS;

export const settledSession = (session) => ({ ...session, settling: null });

/** The session once the person corrected its last turn, so no later judgement of that turn makes it a candidate again. */
export const correctedSession = (session) => ({ ...session, correctedTurn: session.turn });

export const isCorrected = (session, turn) => session.correctedTurn >= turn;

/**
 * The session with `assetIds` noted as shown to the agent before any turn booked them, so no later recall of the
 * session offers them again; undefined when `turn` is no longer the open turn.
 */
export function withShown(session, assetIds, turn) {
  if (!(session.open && session.turn === turn)) return undefined;
  return { ...session, shown: [...session.shown.filter((id) => !assetIds.includes(id)), ...assetIds].slice(-MAX_SHOWN) };
}

/** The assets the session has seen, booked or only shown: a recall offers none of them again. */
export const listedIdsOf = (session) => new Set([...Object.keys(session.injected), ...session.shown]);

/**
 * The session with each asset of a recall's match (`{ ids, text, stepTexts? }`) booked for `turn`: a Recipe's step
 * under its own strategy, a single asset under the whole text. The open turn keeps the whole text to replay. `added`
 * is false when every asset was booked already.
 */
export function withInjection(session, { ids, text, stepTexts = {} }, turn, now) {
  const fresh = ids.filter((id) => !session.injected[id]);
  if (fresh.length === 0) return { next: undefined, added: false };
  const strategy = session.open && session.turn === turn ? text : session.strategy;
  const injected = fresh.reduce((ledger, id) => withInjected(ledger, id, { turn, strategyText: stepTexts[id] ?? text }, now), session.injected);
  return { next: { ...session, strategy, injected }, added: true };
}

function dueOf(session, sessionId, turn) {
  return unreportedAssets(session.injected, turn).map((asset) => ({ ...asset, sessionId, turn: session.injected[asset.assetId].turn }));
}

// An injection adopted from a host's standalone plugin belongs to a turn this plugin never saw end: no later turn's
// evidence is its own, so it is only ever reported as aborted, at the next session start.
const isAdopted = (session, asset) => Boolean(session.injected[asset.assetId]?.adopted);

/** The injections of turns up to `turn` that no report covered yet; nothing is marked, so they can be queued first. */
export const unreportedOf = (session, sessionId, turn) => dueOf(session, sessionId, turn).filter((asset) => !isAdopted(session, asset));

/** The session with `assets` marked reported; `next` is undefined when none of them was still unreported. */
export function markedReported(session, assets, now) {
  const ids = assets.map((asset) => asset.assetId).filter((id) => session.injected[id] && !session.injected[id].reportedAt);
  return ids.length > 0 ? { ...session, injected: withReported(session.injected, ids, now) } : undefined;
}

/**
 * Injections no turn end will ever report: all of a killed session's (its owner process is gone), and any session's
 * adopted from a standalone plugin.
 */
export function orphansOf(session, sessionId, isGone) {
  if (!sessionId) return [];
  const due = dueOf(session, sessionId, Infinity);
  return isGone(session.pid) ? due : due.filter((asset) => isAdopted(session, asset));
}

/**
 * Whether an event naming `turnId` comes late: the session has since opened another turn. An id it never opened (a
 * host's intercepted command, say) is no earlier turn, so it is not stale.
 */
export const isEarlierTurn = (session, turnId) => Boolean(turnId) && turnId !== session.turnId && session.turnIds.includes(turnId);

/** What an ended session keeps: its turn counter, owner and ledger, so a resume neither repeats a task id nor re-injects. */
export function endedSession(session) {
  return { ...EMPTY_SESSION, turn: session.turn, pid: session.pid, injected: session.injected, turnIds: session.turnIds, shown: session.shown };
}

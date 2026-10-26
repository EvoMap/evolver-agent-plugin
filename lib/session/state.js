// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { unreportedAssets, withInjected, withReported } from '../injected-ledger.js';

// One session's state as plain data, and every change to it as a function from state to state. The turn counter
// outlives the session's end, so a resumed session never repeats a task id the Hub would take for a duplicate.

export const EMPTY_SESSION = Object.freeze({
  turn: 0, turnId: null, open: false, turnStart: null, prompt: '', isCommand: false, strategy: '',
  labelable: [], injected: {}, pid: null, startedUnder: null, settling: null,
});

// A turn end that died halfway leaves `settling` behind; past this age it no longer holds the next prompt up.
const SETTLING_STALE_MS = 30_000;

export const sessionOf = (stored) => ({ ...EMPTY_SESSION, ...stored });

export function openedTurn(session, { turnId = null, turnStart = null, prompt = '', pid = null, isCommand = false }) {
  return {
    ...session,
    turn: session.turn + 1,
    turnId,
    open: true,
    turnStart,
    prompt,
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

export function withInjection(session, assetId, { turn, strategyText }, now) {
  if (session.injected[assetId]) return { next: undefined, added: false };
  const strategy = session.open && session.turn === turn ? strategyText : session.strategy;
  return { next: { ...session, strategy, injected: withInjected(session.injected, assetId, { turn, strategyText }, now) }, added: true };
}

function dueOf(session, sessionId, turn) {
  return unreportedAssets(session.injected, turn).map((asset) => ({ ...asset, sessionId, turn: session.injected[asset.assetId].turn }));
}

/** The injections of turns up to `turn` that no report covered yet; nothing is marked, so they can be queued first. */
export const unreportedOf = (session, sessionId, turn) => dueOf(session, sessionId, turn);

/** The session with `assets` marked reported; `next` is undefined when none of them was still unreported. */
export function markedReported(session, assets, now) {
  const ids = assets.map((asset) => asset.assetId).filter((id) => session.injected[id] && !session.injected[id].reportedAt);
  return ids.length > 0 ? { ...session, injected: withReported(session.injected, ids, now) } : undefined;
}

/** A killed session's unreported injections: its owner process is gone, so no turn end will ever report them. */
export function orphansOf(session, sessionId, isGone) {
  if (!sessionId || !isGone(session.pid)) return [];
  return dueOf(session, sessionId, Infinity);
}

/** What an ended session keeps: its turn counter, owner and ledger, so a resume neither repeats a task id nor re-injects. */
export function endedSession(session) {
  return { ...EMPTY_SESSION, turn: session.turn, pid: session.pid, injected: session.injected };
}

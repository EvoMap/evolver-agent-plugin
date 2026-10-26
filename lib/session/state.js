// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { unreportedAssets, withInjected, withReported } from '../injected-ledger.js';

// One session's state as plain data, and every change to it as a function from state to state. The turn counter
// outlives the session's end, so a resumed session never repeats a task id the Hub would take for a duplicate.

export const EMPTY_SESSION = Object.freeze({
  turn: 0, turnId: null, open: false, turnStart: null, prompt: '', isCommand: false, strategy: '',
  labelable: [], injected: {}, pid: null, ended: false, settling: false,
});

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
    ended: false,
    labelable: isCommand ? session.labelable : [],
  };
}

const isOpenTurn = (session, turnId) => session.open && (!turnId || !session.turnId || turnId === session.turnId);

/**
 * The session with `turnId` (any turn when omitted) closed, and the turn as it was; `next` is undefined when none was
 * open. It stays `settling` until the turn's reports and candidate are written, so a prompt that arrives meanwhile
 * waits rather than labelling or dropping what is not there yet.
 */
export function closedTurn(session, turnId) {
  if (!isOpenTurn(session, turnId)) return { next: undefined, opened: null };
  return { next: { ...session, open: false, settling: true }, opened: session };
}

/** Whether the last turn has finished closing: its reports and candidate are written. */
export const isSettled = (session) => !session.open && !session.settling;

export function withInjection(session, assetId, { turn, strategyText }, now) {
  if (session.injected[assetId]) return { next: undefined, added: false };
  const strategy = session.open && session.turn === turn ? strategyText : session.strategy;
  return { next: { ...session, strategy, injected: withInjected(session.injected, assetId, { turn, strategyText }, now) }, added: true };
}

function dueOf(session, sessionId, turn) {
  return unreportedAssets(session.injected, turn).map((asset) => ({ ...asset, sessionId, turn: session.injected[asset.assetId].turn }));
}

/** The injections of turns up to `turn` that no report covered yet, taken: marked reported in `next`. */
export function takenUnreported(session, sessionId, turn, now) {
  const due = dueOf(session, sessionId, turn);
  if (due.length === 0) return { next: undefined, due };
  return { next: { ...session, injected: withReported(session.injected, due.map((asset) => asset.assetId), now) }, due };
}

/** A killed session's unreported injections: its owner process is gone, so no turn end will ever report them. */
export function takenOrphans(session, sessionId, isGone, now) {
  if (!sessionId || !isGone(session.pid)) return { next: undefined, due: [] };
  const { next, due } = takenUnreported(session, sessionId, Infinity, now);
  return { next: next && { ...next, open: false }, due };
}

/** What an ended session keeps: its turn counter, owner and ledger, so a resume neither repeats a task id nor re-injects. */
export function endedSession(session) {
  return { ...EMPTY_SESSION, turn: session.turn, pid: session.pid, injected: session.injected, ended: true };
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withoutDraftsForTurn } from '../distill.js';
import { withSessionActivity, withoutCandidate } from '../distill/candidate.js';
import { promptTextOf, recallStrategy, taskTextOf } from '../recall.js';
import { correctionReportsOf, followUpLabelOf } from '../session/follow-ups.js';
import { correctedSession, joinedWaiting, listedIdsOf, openedTurn, sessionOf, withInjection, withShown, withWaiting } from '../session/state.js';
import { scheduleDueDistillation } from './distill-session.js';
import { TASKS } from './ports.js';

export const CLOSING = 'Apply them where they fit.';
// A Recipe still pending this close to the hook's deadline gives way to the single strategy, which needs the rest to be booked.
const RECIPE_MARGIN_MS = 300;
const LATE_RECIPE_WAIT_MS = 6_000;

async function correctedTurnOf({ sessions, draftCorrections }, sessionId) {
  const corrected = await sessions.update(sessionId, (stored) => correctedSession(sessionOf(stored)));
  const { correctedTurn: turn, sessionEpoch } = corrected;
  if (turn > 0) await draftCorrections.mark(sessionId, turn, sessionEpoch);
  return { turn, sessionEpoch };
}

// The lock only orders the mark against a publication's last check. One held past its wait must not cost the person
// their turn and its recall, so the correction is then recorded without it and the hook reports the skipped lock.
async function recordedCorrection(ports, sessionId) {
  const correct = () => correctedTurnOf(ports, sessionId);
  try {
    return await ports.draftCorrections.withSession(sessionId, correct);
  } catch (error) {
    if (error?.code !== 'ELOCKED') throw error;
    return { ...(await correct()), skipped: error };
  }
}

/**
 * The next prompt is the only verdict on a turn available without asking anyone: a correction drops the
 * session's candidate and that turn's drafts, then its reuses are reported again under `:correction`. Mark the
 * turn first so a re-judge sees the correction, and drop the candidate before removing drafts so a late write
 * after the removal still sees the candidate is gone.
 * Any other prompt is the session's activity, which a candidate waits out before it is distilled. Answers the
 * error of a correction lock it had to go without, if any.
 */
async function labelFollowUp(ports, sessionId, prompt) {
  const { sessions, candidates, drafts, reports, clock } = ports;
  const label = followUpLabelOf(prompt);
  let skipped;
  if (label === 'correction') {
    const correction = await recordedCorrection(ports, sessionId);
    skipped = correction.skipped;
    await candidates.update((pending) => withoutCandidate(pending, sessionId));
    if (correction.turn > 0) await drafts.update((list) => withoutDraftsForTurn(list, sessionId, correction.turn, correction.sessionEpoch));
  } else {
    await candidates.update((pending) => withSessionActivity(pending, sessionId, clock.now()));
  }
  const queued = correctionReportsOf(sessionOf(await sessions.read(sessionId)).labelable, label, sessionId);
  if (queued.length > 0) await reports.enqueue(queued);
  await scheduleDueDistillation(ports, queued.length > 0 ? [TASKS.DRAIN] : []);
  return skipped;
}

/** A recall's match when it brings a strategy (`{ ids, text, stepTexts? }`, a Recipe's steps or one asset), else null. */
const strategyOf = (match) => (match?.ids?.length && match.text ? match : null);

/** Books a recalled strategy into `turn` and answers its text, '' when it brings none or books nothing new. */
export async function booked({ sessions, clock }, sessionId, { turn, match, onlyWhileOpen = false }) {
  if (!strategyOf(match)) return '';
  let added = false;
  await sessions.update(sessionId, (stored) => {
    const session = sessionOf(stored);
    if (onlyWhileOpen && !(session.open && session.turn === turn)) return undefined;
    const result = withInjection(session, match, turn, clock.now());
    added = result.added;
    return result.next;
  });
  return added ? match.text : '';
}

async function shown({ sessions }, sessionId, { turn, ids }) {
  let isOpen = false;
  await sessions.update(sessionId, (stored) => {
    const next = withShown(sessionOf(stored), ids, turn);
    isOpen = Boolean(next);
    return next;
  });
  return isOpen;
}

async function waitForToolResult({ sessions }, sessionId, { turn, match }) {
  const strategy = strategyOf(match);
  if (strategy) await sessions.update(sessionId, (stored) => withWaiting(sessionOf(stored), strategy, turn));
}

async function recalled(ports, sessionId, { turn, prompt, waitMs, keepLate, holdForToolResult }) {
  const session = sessionOf(await ports.sessions.read(sessionId));
  const listedIds = listedIdsOf(session);
  const context = session.task ? { task: session.task, trigger: 'turn_start' } : null;
  const proxyFetch = (method, path, body) => ports.proxy.request(method, path, body);
  const recipeCutoff = ports.clock.sleep(waitMs > 0 ? Math.max(0, waitMs - RECIPE_MARGIN_MS) : LATE_RECIPE_WAIT_MS);
  const recall = recallStrategy(proxyFetch, promptTextOf(prompt), { context, listedIds, closingOf: () => CLOSING, recipeCutoff });
  const TIMED_OUT = Symbol('timed out');
  const match = waitMs > 0 ? await Promise.race([recall, ports.clock.sleep(waitMs).then(() => TIMED_OUT)]) : TIMED_OUT;
  if (match !== TIMED_OUT && holdForToolResult) {
    await waitForToolResult(ports, sessionId, { turn, match });
    return { injection: '' };
  }
  if (match !== TIMED_OUT) return { injection: await booked(ports, sessionId, { turn, match }) };
  if (!keepLate) return { injection: '' };
  const late = recall.then((landed) => (strategyOf(landed) ? {
    text: landed.text,
    show: () => shown(ports, sessionId, { turn, ids: landed.ids }),
    join: async () => (await booked(ports, sessionId, { turn, match: landed, onlyWhileOpen: true })) !== '',
  } : null)).catch(() => null);
  return { injection: '', late };
}

/**
 * Opens the session's next turn and recalls one strategy for it within `waitMs`: a hook cannot add context once
 * it has answered. With `keepLate`, for a host that can add context to a running turn, a slower recall keeps going:
 * `late` resolves to `{ text, show, join }`. `show()` answers whether the turn is still open and keeps the strategy
 * out of the session's later recalls, for a host that adds it before a model step carries it; `join()` books it,
 * only while the turn is still open, once a model step does. With `holdForToolResult`, for a host whose prompt hook
 * cannot add context, a strategy that lands in time waits for the turn's first tool result instead (see
 * `takeWaitingStrategy`). A plugin command's turn keeps the last real turn's reuses for the next prompt to label, is
 * recalled for nothing and never becomes a distillation candidate. `skipped` is the error of a correction lock the
 * prompt went without.
 */
export async function promptSubmitted(ports, { sessionId, prompt, turnId = null, turnStart = null, hostTurn = null, isCommand = false, waitMs, keepLate = false, holdForToolResult = false }) {
  const skipped = isCommand ? undefined : await labelFollowUp(ports, sessionId, prompt);
  await ports.notes.clear(sessionId);
  const opened = await ports.sessions.update(sessionId, (stored) =>
    openedTurn(sessionOf(stored), { turnId, turnStart, hostTurn, prompt: prompt ? promptTextOf(prompt) : null, task: taskTextOf(prompt), pid: ports.owner.current(), isCommand, now: ports.clock.now() }));
  const wantsRecall = !isCommand && ports.settings?.recall !== false;
  const { injection, late } = wantsRecall ? await recalled(ports, sessionId, { turn: opened.turn, prompt, waitMs, keepLate, holdForToolResult }) : { injection: '' };
  return { turn: opened.turn, injection, ...(late && { late }), ...(skipped && { skipped }) };
}

/**
 * The strategy waiting for the open turn's first tool result, booked as injected now that the host adds it there; ''
 * when none waits, the turn it waited for has ended, or the result names another turn than the open one. Only one
 * tool result of a turn takes it.
 */
export async function takeWaitingStrategy({ sessions, clock }, { sessionId, turnId = null }) {
  if (!sessionOf(await sessions.read(sessionId)).waiting) return '';
  let text = '';
  await sessions.update(sessionId, (stored) => {
    const joined = joinedWaiting(sessionOf(stored), { turnId, now: clock.now() });
    text = joined.text;
    return joined.next;
  });
  return text;
}

/**
 * The session's last turn, `{ turn, turnId, strategy }`, its strategy only while it is open, or null before the
 * first: a host whose injection lasts one model call replays it, and one more call of a closed turn opens none.
 */
export async function lastTurnOf({ sessions }, sessionId) {
  const session = sessionOf(await sessions.read(sessionId));
  return session.turn > 0 ? { turn: session.turn, turnId: session.turnId, strategy: session.open ? session.strategy : '' } : null;
}

/**
 * Adopts a strategy a command found into the session's ledger: for the turn it was found in, or the next one when
 * a command found it between turns, so that turn's end reports its reuse. Only for a host whose command answers
 * reach the model; a strategy the model never saw is no reuse.
 */
export async function adoptStrategy({ sessions, clock }, { sessionId, strategy }) {
  await sessions.update(sessionId, (stored) => {
    const session = sessionOf(stored);
    const turn = session.open && !session.isCommand ? session.turn : session.turn + 1;
    return withInjection(session, strategy, turn, clock.now()).next;
  });
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withoutCandidate } from '../distill/candidate.js';
import { promptTextOf, recallStrategy } from '../recall.js';
import { correctionReportsOf, followUpLabelOf } from '../session/follow-ups.js';
import { correctedSession, openedTurn, sessionOf, withInjection } from '../session/state.js';
import { TASKS } from './ports.js';

const CLOSING = 'Apply them where they fit.';

/**
 * The next prompt is the only verdict on a turn available without asking anyone: a correction drops the
 * session's candidate first, then the last turn's reuses are reported again under `:correction`. The session is
 * marked corrected before the drop, so a re-judge of that turn writing meanwhile sees the mark and takes its write back.
 */
async function labelFollowUp({ sessions, candidates, reports, scheduler }, sessionId, prompt) {
  const label = followUpLabelOf(prompt);
  if (label === 'correction') {
    await sessions.update(sessionId, (stored) => correctedSession(sessionOf(stored)));
    await candidates.update((pending) => withoutCandidate(pending, sessionId));
  }
  const queued = correctionReportsOf(sessionOf(await sessions.read(sessionId)).labelable, label, sessionId);
  if (queued.length === 0) return;
  await reports.enqueue(queued);
  scheduler.schedule([TASKS.DRAIN]);
}

async function booked({ sessions, clock }, sessionId, { turn, match, onlyWhileOpen = false }) {
  const [assetId] = match?.ids ?? [];
  if (!assetId || !match.text) return '';
  let added = false;
  await sessions.update(sessionId, (stored) => {
    const session = sessionOf(stored);
    if (onlyWhileOpen && !(session.open && session.turn === turn)) return undefined;
    const result = withInjection(session, assetId, { turn, strategyText: match.text }, clock.now());
    added = result.added;
    return result.next;
  });
  return added ? match.text : '';
}

async function recalled(ports, sessionId, { turn, prompt, waitMs, keepLate }) {
  const listedIds = new Set(Object.keys(sessionOf(await ports.sessions.read(sessionId)).injected));
  const proxyFetch = (method, path, body) => ports.proxy.request(method, path, body);
  const recall = recallStrategy(proxyFetch, promptTextOf(prompt), { listedIds, closingOf: () => CLOSING });
  const TIMED_OUT = Symbol('timed out');
  const match = await Promise.race([recall, ports.clock.sleep(waitMs).then(() => TIMED_OUT)]);
  if (match !== TIMED_OUT) return { injection: await booked(ports, sessionId, { turn, match }) };
  if (!keepLate) return { injection: '' };
  const late = recall.then((landed) => (landed?.ids?.[0] && landed.text ? {
    text: landed.text,
    join: async () => (await booked(ports, sessionId, { turn, match: landed, onlyWhileOpen: true })) !== '',
  } : null)).catch(() => null);
  return { injection: '', late };
}

/**
 * Opens the session's next turn and recalls one strategy for it within `waitMs`: a hook cannot add context once
 * it has answered. With `keepLate`, for a host that can add context to a running turn, a slower recall keeps going:
 * `late` resolves to `{ text, join }`, and `join()` books it, only while the turn is still open, when the host adds it. A plugin command's turn keeps the last real turn's reuses for the next prompt to label, is
 * recalled for nothing and never becomes a distillation candidate.
 */
export async function promptSubmitted(ports, { sessionId, prompt, turnId = null, turnStart = null, isCommand = false, waitMs, keepLate = false }) {
  if (!isCommand) await labelFollowUp(ports, sessionId, prompt);
  await ports.notes.clear(sessionId);
  const opened = await ports.sessions.update(sessionId, (stored) =>
    openedTurn(sessionOf(stored), { turnId, turnStart, prompt: promptTextOf(prompt), pid: ports.owner.current(), isCommand }));
  const wantsRecall = !isCommand && ports.settings?.recall !== false;
  const { injection, late } = wantsRecall ? await recalled(ports, sessionId, { turn: opened.turn, prompt, waitMs, keepLate }) : { injection: '' };
  return { turn: opened.turn, injection, ...(late && { late }) };
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
    return withInjection(session, strategy.assetId, { turn, strategyText: strategy.text }, clock.now()).next;
  });
}

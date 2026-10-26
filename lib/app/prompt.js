// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withoutCandidate } from '../distill/candidate.js';
import { promptTextOf, recallStrategy } from '../recall.js';
import { correctionReportsOf, followUpLabelOf } from '../session/follow-ups.js';
import { openedTurn, sessionOf, withInjection } from '../session/state.js';
import { TASKS } from './ports.js';

const CLOSING = 'Apply them where they fit.';

/**
 * The next prompt is the only verdict on a turn available without asking anyone: a correction drops the
 * session's candidate first, then the last turn's reuses are reported again under `:correction`.
 */
async function labelFollowUp({ sessions, candidates, reports, scheduler }, sessionId, prompt) {
  const label = followUpLabelOf(prompt);
  if (label === 'correction') await candidates.update((pending) => withoutCandidate(pending, sessionId));
  const queued = correctionReportsOf(sessionOf(await sessions.read(sessionId)).labelable, label, sessionId);
  if (queued.length === 0) return;
  await reports.enqueue(queued);
  scheduler.schedule([TASKS.DRAIN]);
}

async function recalled({ sessions, proxy, clock }, sessionId, { turn, prompt, waitMs }) {
  const listedIds = new Set(Object.keys(sessionOf(await sessions.read(sessionId)).injected));
  const proxyFetch = (method, path, body) => proxy.request(method, path, body);
  const match = await Promise.race([
    recallStrategy(proxyFetch, promptTextOf(prompt), { listedIds, closingOf: () => CLOSING }),
    clock.sleep(waitMs).then(() => null),
  ]);
  const [assetId] = match?.ids ?? [];
  if (!assetId || !match.text) return '';
  let added = false;
  await sessions.update(sessionId, (stored) => {
    const result = withInjection(sessionOf(stored), assetId, { turn, strategyText: match.text }, clock.now());
    added = result.added;
    return result.next;
  });
  return added ? match.text : '';
}

/**
 * Opens the session's next turn and recalls one strategy for it within `waitMs`: a hook cannot add context once
 * it has answered. A plugin command's turn keeps the last real turn's reuses for the next prompt to label, is
 * recalled for nothing and never becomes a distillation candidate.
 */
export async function promptSubmitted(ports, { sessionId, prompt, turnId = null, turnStart = null, isCommand = false, waitMs }) {
  if (!isCommand) await labelFollowUp(ports, sessionId, prompt);
  await ports.notes.clear(sessionId);
  const opened = await ports.sessions.update(sessionId, (stored) =>
    openedTurn(sessionOf(stored), { turnId, turnStart, prompt: promptTextOf(prompt), pid: ports.owner.current(), isCommand }));
  const injection = isCommand ? '' : await recalled(ports, sessionId, { turn: opened.turn, prompt, waitMs });
  return { turn: opened.turn, injection };
}

/** The session's open turn, `{ turn, turnId, strategy }`, or null: a host whose injection lasts one model call replays it. */
export async function openTurnOf({ sessions }, sessionId) {
  const session = sessionOf(await sessions.read(sessionId));
  return session.open ? { turn: session.turn, turnId: session.turnId, strategy: session.strategy } : null;
}

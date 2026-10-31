// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { recallStrategy } from '../recall.js';
import { listedIdsOf, sessionOf, withStuckQuery } from '../session/state.js';
import { languagesOf, stuckQueryOf } from '../stuck-query.js';
import { isFailedCheck, turnRecordOf } from '../turn/record.js';
import { booked, CLOSING } from './prompt.js';

const belongsToOpenTurn = (session, turnId) => session.open && (!turnId || !session.turnId || turnId === session.turnId);

async function claimed({ sessions }, sessionId, query, turn) {
  let isClaimed = false;
  await sessions.update(sessionId, (stored) => {
    const next = withStuckQuery(sessionOf(stored), query, turn);
    isClaimed = Boolean(next);
    return next;
  });
  return isClaimed;
}

function contextOf(session, paths) {
  const language = languagesOf(paths);
  return { ...(session.task && { task: session.task }), trigger: 'check_failed', ...(language.length > 0 && { language }) };
}

/**
 * A failed check is where the agent most needs a fact it lacks, and its output names the problem far better than the
 * prompt's opening: the open turn recalls once per distinct failure, two at most, with a query built from that output
 * and what the turn touched (lib/stuck-query.js), the session's task beside it. Answers the strategy to add to the
 * failed call's result, booked into the turn, or '' when none lands within `waitMs`; a slower one is dropped, since
 * the agent has moved on by then.
 */
export async function recallWhenStuck(ports, { sessionId, turnId = null, note, waitMs }) {
  if (ports.settings?.recall === false || !isFailedCheck(note)) return '';
  const session = sessionOf(await ports.sessions.read(sessionId));
  if (!belongsToOpenTurn(session, turnId) || session.isCommand) return '';
  const record = turnRecordOf(await ports.notes.read(sessionId));
  const query = stuckQueryOf({ output: note.output, paths: record.paths, identifiers: record.identifiers });
  if (!query || !(await claimed(ports, sessionId, query, session.turn))) return '';
  const proxyFetch = (method, path, body) => ports.proxy.request(method, path, body);
  const recall = recallStrategy(proxyFetch, query, {
    context: contextOf(session, record.paths),
    listedIds: listedIdsOf(session),
    closingOf: () => CLOSING,
  });
  const match = await Promise.race([recall, ports.clock.sleep(waitMs).then(() => null)]);
  return booked(ports, sessionId, { turn: session.turn, match, onlyWhileOpen: true });
}

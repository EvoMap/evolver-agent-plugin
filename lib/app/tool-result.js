// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { sessionOf } from '../session/state.js';

const belongsToOpenTurn = (session, turnId) => session.open && (!turnId || !session.turnId || turnId === session.turnId);

/**
 * Records what one tool call did (see lib/turn/record.js). A note of no open turn, or of another turn than the open
 * one (a late result of a turn already ended), is dropped: it is no evidence of the turn now running.
 */
export async function toolFinished({ sessions, notes }, { sessionId, turnId = null, note }) {
  if (!belongsToOpenTurn(sessionOf(await sessions.read(sessionId)), turnId)) return;
  await notes.append(sessionId, note);
}

/** Remembers a file's content before the turn first edits it, for the next session's retention check. */
export function beforeEdit({ baseline }, { sessionId, file }) {
  return baseline.remember(sessionId, file);
}

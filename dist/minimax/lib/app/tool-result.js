// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { sessionOf } from '../session/state.js';

const belongsToOpenTurn = (session, turnId) => session.open && (!turnId || !session.turnId || turnId === session.turnId);

/**
 * Records what one tool call did (see lib/turn/record.js). A note of no open turn, or of another turn than the open
 * one (a late result of a turn already ended), is dropped: it is no evidence of the turn now running. Each note keeps
 * its turn, so one that raced past the check is still told apart when the turn ends.
 */
export async function toolFinished({ sessions, notes }, { sessionId, turnId = null, note }) {
  const session = sessionOf(await sessions.read(sessionId));
  if (!belongsToOpenTurn(session, turnId)) return;
  await notes.append(sessionId, { ...note, turnId: session.turnId });
}

/** Remembers a file's content before the open turn first edits it, for the next session's retention check. */
export async function beforeEdit({ sessions, baseline }, { sessionId, turnId = null, file }) {
  const session = sessionOf(await sessions.read(sessionId));
  if (!belongsToOpenTurn(session, turnId)) return;
  await baseline.remember(sessionId, file, session.turnId);
}

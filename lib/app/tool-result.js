// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

/** Records what one tool call did: `{ kind: 'shell' | 'edit' | 'tool', command?, exit?, output?, running?, callId?, paths? }`. */
export function toolFinished({ notes }, { sessionId, note }) {
  return notes.append(sessionId, note);
}

/** Remembers a file's content before the turn first edits it, for the next session's retention check. */
export function beforeEdit({ baseline }, { sessionId, file }) {
  return baseline.remember(sessionId, file);
}

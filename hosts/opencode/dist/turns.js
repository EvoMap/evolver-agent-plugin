// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// What the entry sees of each session's running turn, from OpenCode's event stream: whether the session is busy,
// its latest assistant message, the error it raised and the answer it wrote. A turn opens with the person's
// prompt and closes the first time its session goes idle. A context overflow publishes `session.error` and then
// compacts and carries on in a new assistant message, so an error only stands while no later message started.

function answerOf(turn, messageID, text) {
  const written = turn.answerMessageID === messageID ? turn.written + (text ?? '') : text ?? '';
  return { answerMessageID: messageID, written, answer: written.trim() || turn.answer };
}

export function createTurnTracker() {
  const turns = new Map();
  const busy = new Set();
  return {
    open(sessionID, turnID) {
      turns.set(sessionID, { turnID, error: null, errorDuring: null, lastAssistant: null, answerMessageID: null, written: '', answer: '' });
    },
    isOpen: (sessionID) => turns.has(sessionID),
    openTurnOf: (sessionID) => turns.get(sessionID)?.turnID ?? null,
    isBusy: (sessionID) => busy.has(sessionID),
    noteStatus(sessionID, status) {
      if (status?.type === 'idle') busy.delete(sessionID);
      else busy.add(sessionID);
    },
    noteAssistant(sessionID, info) {
      const turn = turns.get(sessionID);
      if (!turn) return;
      if (turn.error && info.id !== turn.errorDuring) turn.error = null;
      turn.lastAssistant = info;
    },
    noteError(sessionID, error) {
      const turn = turns.get(sessionID);
      if (!turn || !error) return;
      turn.error = error;
      turn.errorDuring = turn.lastAssistant?.id ?? null;
    },
    noteText(sessionID, messageID, text) {
      const turn = turns.get(sessionID);
      if (turn) Object.assign(turn, answerOf(turn, messageID, text));
    },
    /** The turn's end as `{ turnID, error, lastAssistant, answer }`, or null when none was open. */
    close(sessionID) {
      const turn = turns.get(sessionID);
      turns.delete(sessionID);
      return turn ? { turnID: turn.turnID, error: turn.error, lastAssistant: turn.lastAssistant, answer: turn.answer } : null;
    },
  };
}

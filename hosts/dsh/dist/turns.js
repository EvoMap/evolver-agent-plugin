// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { answerTextOf } from '../messages.js';

const NOTHING_SEEN = Object.freeze({ lastAssistant: null, answer: '' });

export function createTurnTracker() {
  const turns = new Map();
  const openOf = (sessionId, turn) => {
    const open = turns.get(sessionId);
    return open?.turn === turn ? open : null;
  };
  return {
    open(sessionId, turn) {
      turns.set(sessionId, { turn, lastAssistant: null, answer: '', late: null });
    },
    openTurnOf: (sessionId) => turns.get(sessionId)?.turn ?? null,
    noteAssistant(sessionId, turn, message) {
      const open = openOf(sessionId, turn);
      if (!open) return;
      open.lastAssistant = message;
      open.answer = answerTextOf(message) || open.answer;
    },
    landLate(sessionId, turn, landed) {
      const open = openOf(sessionId, turn);
      if (open) open.late = landed;
    },
    takeLate(sessionId, turn) {
      const open = openOf(sessionId, turn);
      const late = open?.late ?? null;
      if (open) open.late = null;
      return late;
    },
    close(sessionId, turn) {
      const open = openOf(sessionId, turn);
      if (!open) return NOTHING_SEEN;
      turns.delete(sessionId);
      return open;
    },
    forget: (sessionId) => turns.delete(sessionId),
  };
}

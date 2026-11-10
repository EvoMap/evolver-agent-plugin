// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The calibration corpus: every range that reached the gate, kept on this machine as it would be sent, so a new
// prompt, gate or Proxy rule can be measured on the same sessions as the last (scripts/distill-calibrate.mjs).
// Everything in it is redacted under the rules it was kept by.

import { redactedAgain } from './work-turn.js';

export const CORPUS_MAX_ENTRIES = 200;

export function corpusEntryOf({ platform, sessionId, trigger, range, gate, kind, session, now }) {
  return {
    at: now,
    platform,
    session_id: sessionId,
    trigger,
    gate: { passed: gate.passed, reason: gate.reason, work_turns: gate.workTurns, episodes: gate.episodes },
    kind,
    source: range.source ?? null,
    turns: range.turns.map(({ modelBinding, ...turn }) => redactedAgain(turn)),
    record: session.record,
    user_prompt: session.userPrompt,
    final_answer: session.finalAnswer,
    execution: { trace: session.trace },
    ...(session.project && { project: session.project }),
    ...(session.projectDir && { project_dir: session.projectDir }),
  };
}

/** A corpus entry as the record builder reads a range again: its turns, project and source. */
export const rangeOfCorpusEntry = (entry) => ({
  turns: entry.turns,
  source: entry.source,
  project: entry.project ?? null,
  projectDir: entry.project_dir ?? null,
});

export const withCorpusEntry = (corpus, entry) => [...(Array.isArray(corpus) ? corpus : []), entry].slice(-CORPUS_MAX_ENTRIES);

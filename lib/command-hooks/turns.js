// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// What a command-hook host's three events do, over one session's state:
// a prompt recalls and injects, the turn's end reports what the injection
// produced, and a session's start delivers what earlier ones left queued.
// Every IO call arrives in `io`, so a host runner only supplies its own.

import { appliedVerdictOf } from '../applied.js';
import { feedbackLabelOf } from '../feedback-label.js';
import { unreportedAssets, withInjected, withReported } from '../injected-ledger.js';
import { promptTextOf, recallStrategy } from '../recall.js';
import { OUTBOX_TTL_MS, withQueued } from '../report-outbox.js';
import { correctionReportOf, deliverPending, immediateReportOf, reportedReuseOf } from '../reuse.js';
import { turnSummaryOf } from '../turn-summary.js';

export const EMPTY_STATE = Object.freeze({ ledger: {}, names: {}, turns: 0, labelable: [], mark: null, outbox: {}, touchedAt: 0 });

const PROMPT_FIELDS = ['prompt', 'user_prompt', 'message', 'text', 'input'];

export function promptOf(input) {
  for (const source of [input, input?.payload]) {
    for (const field of PROMPT_FIELDS) {
      if (typeof source?.[field] === 'string' && source[field].trim()) return source[field];
    }
  }
  return '';
}

export function contextOutput(hookEventName, additionalContext) {
  return additionalContext ? { hookSpecificOutput: { hookEventName, additionalContext } } : {};
}

function reportLedgers(io) {
  return { proxyFetch: io.proxyFetch, recordLocally: io.recordLocally, onRejected: io.onRejected };
}

async function deliver(io, state, queued) {
  const now = io.now();
  const outbox = withQueued(state.outbox, queued, now);
  return { ...state, outbox: await deliverPending(reportLedgers(io), outbox, now) };
}

// A prompt the person sends right after a turn reads as a correction or an
// approval of it; that reuse is reported once more under `:correction`.
function followUpReports(state, sessionId, prompt) {
  const label = feedbackLabelOf(promptTextOf(prompt));
  return state.labelable
    .map((reuse) => correctionReportOf(reuse, label))
    .filter((report) => report !== null)
    .map((report) => ({ report, sessionId }));
}

// The recall races the host's hook timeout: a strategy that lands after the
// deadline has no way into this turn, so it is dropped rather than queued.
async function recallWithin(io, text, listedIds) {
  const recall = recallStrategy(io.proxyFetch, text, { listedIds, minSimilarity: io.minSimilarity });
  const late = io.sleep(io.recallWaitMs).then(() => null);
  return (await Promise.race([recall, late])) ?? { ids: [], text: '' };
}

export async function onPromptSubmit(io, { sessionId, input, transcriptSize }) {
  const prompt = promptOf(input);
  let state = { ...io.readState(), mark: { offset: transcriptSize } };
  state = await deliver(io, { ...state, labelable: [] }, followUpReports(state, sessionId, prompt));
  const turn = state.turns + 1;
  state.turns = turn;
  const text = promptTextOf(prompt);
  const match = text ? await recallWithin(io, text, new Set(Object.keys(state.ledger))) : { ids: [], text: '' };
  if (match.text) {
    const now = io.now();
    state.ledger = match.ids.reduce(
      (ledger, id) => withInjected(ledger, id, { turn, strategyText: match.stepTexts?.[id] ?? match.text }, now),
      state.ledger,
    );
    state.names = { ...state.names, ...Object.fromEntries(match.ids.map((id) => [id, match.name ?? id])) };
  }
  io.writeState({ ...state, touchedAt: io.now() });
  return contextOutput(io.promptEventName, match.text);
}

export async function onTurnEnd(io, { sessionId, input, transcriptChunk }) {
  const state = io.readState();
  const observed = io.turnOf(transcriptChunk);
  const answer = observed.answer || String(input?.last_assistant_message ?? '');
  const due = unreportedAssets(state.ledger, state.turns);
  const reports = due.map((asset) => immediateReportOf({
    asset,
    sessionId,
    turn: state.turns,
    turnReason: 'answer',
    checks: observed.checks,
    applied: appliedVerdictOf({ strategyText: asset.strategyText, commands: observed.commands, paths: observed.paths, edits: observed.edits, answer }).verdict,
  }));
  const reported = { ...state, ledger: withReported(state.ledger, due.map((asset) => asset.assetId), io.now()), labelable: reports.map(reportedReuseOf) };
  const delivered = await deliver(io, reported, reports.map((report) => ({ report, sessionId })));
  io.writeState({ ...delivered, touchedAt: io.now() });
  const reusedNames = due.map((asset) => state.names?.[asset.assetId] ?? asset.assetId);
  const summary = turnSummaryOf({ reusedNames: [...new Set(reusedNames)], lastCheck: observed.checks.at(-1), changedLines: observed.changedLines });
  return summary ? { systemMessage: summary } : {};
}

export async function onSessionStart(io, { otherSessions }) {
  const now = io.now();
  for (const other of otherSessions) {
    const state = other.readState();
    if (now - Number(state.touchedAt) > OUTBOX_TTL_MS) {
      other.remove();
      continue;
    }
    if (Object.keys(state.outbox).length === 0) continue;
    other.writeState({ ...state, outbox: await deliverPending(reportLedgers(io), state.outbox, now) });
  }
  return {};
}

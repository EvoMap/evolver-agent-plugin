// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { fileURLToPath } from 'node:url';

import { defineProfile } from '../../lib/agent/profile.js';
import { editedFileOf, transcriptRecordOf } from './evidence.js';
import { agyModel } from './model.js';
import { latestTurnOf, stepsOf, turnActivityOf } from './transcript.js';

// Antigravity has no prompt event and no session end: the turn opens at the first model call (PreInvocation)
// after a new prompt of the person's shows up in the transcript, and a session is over once its Antigravity
// process is gone. An ephemeral message lasts one model call, so the open turn's strategy is answered again
// before each later call.

const PROMPT_EVENT = 'PreInvocation';

const COMPLETED = /^(?:no_tool_call|model_stop)$/i;
const CUT_SHORT = /max_steps/i;
const CANCELLED = /cancel|interrupt/i;
const FAILED = /error/i;

const text = (value) => (typeof value === 'string' ? value : '');

// The docs name model_stop, max_steps_exceeded and error; agy 1.2.7 and 1.2.9 send NO_TOOL_CALL for a turn that
// finished, and the enum's TERMINATION_REASON_ prefix may come along. A cancelled turn's value is unverified, and
// a reason nobody has named leaves the turn open for a later Stop or the next prompt.
function endReasonOf({ terminationReason, error }) {
  const reason = text(terminationReason).replace(/^termination_reason_/i, '');
  if (CANCELLED.test(reason)) return 'aborted';
  if (error || FAILED.test(reason)) return 'error';
  if (COMPLETED.test(reason)) return 'answer';
  return CUT_SHORT.test(reason) ? 'error' : 'unknown';
}

// A hook runs in the folder of the hooks.json that registered it, so the project is the first workspace: a plain
// path in the docs, a file:// URI in Antigravity's own conversation index. Print mode without --add-dir has none.
function projectDirOf(workspacePaths) {
  const [workspace] = Array.isArray(workspacePaths) ? workspacePaths : [];
  if (!text(workspace)) return null;
  if (!workspace.startsWith('file:')) return workspace;
  try {
    return fileURLToPath(workspace);
  } catch {
    return null;
  }
}

const turns = new WeakMap();

/** The latest prompt and its turn, read once per hook event however many readers ask. */
function latestTurn(context) {
  if (!turns.has(context)) turns.set(context, latestTurnOf(stepsOf(context.transcriptSince(0))));
  return turns.get(context);
}

// PreToolUse and Stop must name a decision: `allow` hands a tool call on to the next hook or the default policy
// unchanged (`{}` makes Antigravity deny the call), and any decision but `continue` lets the turn stop.
const EMPTY_ANSWERS = Object.freeze({ PreToolUse: { decision: 'allow' }, Stop: { decision: 'stop' } });
const emptyOf = (hostEvent) => EMPTY_ANSWERS[hostEvent] ?? {};
const injected = (message, hostEvent) => (message && hostEvent === PROMPT_EVENT ? { injectSteps: [{ ephemeralMessage: message }] } : emptyOf(hostEvent));

export default defineProfile({
  name: 'antigravity',
  label: 'Antigravity',
  events: { [PROMPT_EVENT]: 'prompt', PreToolUse: 'beforeEdit', Stop: 'turnEnd' },
  payload: {
    sessionId: (payload) => text(payload.conversationId) || null,
    turnId: (payload, context) => latestTurn(context)?.turnId ?? null,
    prompt: (payload, context) => latestTurn(context)?.prompt ?? '',
    projectDir: (payload) => projectDirOf(payload.workspacePaths),
    isIgnored: (payload) => Boolean(text(payload.parentConversationId)),
    model: (payload) => (text(payload.modelName) ? { model: payload.modelName } : null),
    transcriptPath: (payload) => text(payload.transcriptPath) || null,
  },
  sessionStart: 'owner-change',
  reply: {
    context: injected,
    notice: injected,
    empty: emptyOf,
    command: (result, hostEvent) => emptyOf(hostEvent),
    turnEnd: (ended, hostEvent) => emptyOf(hostEvent),
    lifetime: 'call',
  },
  evidence: {
    toolNote: () => null,
    editedFile: (payload) => editedFileOf(payload.toolCall),
    turnStart: (payload, context) => latestTurn(context)?.mark ?? null,
    turnRecord: (payload, context) => (context.turnStart ? transcriptRecordOf(stepsOf(context.transcriptSince(0)), context.turnStart) : null),
  },
  turnEnd: {
    reason: endReasonOf,
    answer: (payload, context) => turnActivityOf(latestTurn(context)?.steps ?? []).answer,
  },
  commands: { sessionOf: (env) => env.ANTIGRAVITY_CONVERSATION_ID || null },
  budgets: { prompt: 10_000 },
  owner: { ancestor: /^(?:agy|language_server)/i },
  model: agyModel,
  legacy: [{ ledgers: /^antigravity-injected-[0-9a-f]{16}\.json$/ }],
});

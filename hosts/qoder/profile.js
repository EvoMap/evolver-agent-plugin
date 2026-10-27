// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { EVENTS } from '../../lib/agent/events.js';
import { defineProfile } from '../../lib/agent/profile.js';
import { endedTurnSummaryOf } from '../../lib/turn-summary.js';
import { promptCommandOf } from './commands.js';
import { editedFilesOf, toolNoteOf } from './evidence.js';
import { headlessQodercli } from './headless.js';

// A turn that failed on a model error ends with StopFailure; one the person interrupted runs no Stop, only the
// undocumented QueryEnd Qoder sends once for every turn of the main agent, with `reason: "abort"`. It must close the
// turn at once: a background command's completion comes back as a `<task-notification>` prompt Qoder submits itself,
// no turn of the person's, whose tool calls name no turn and would land in one still open. The next prompt is the
// fallback for a turn no hook closed.

const STOP = 'Stop';
const STOP_FAILURE = 'StopFailure';
const QUERY_END = 'QueryEnd';
const QUERY_END_REASONS = Object.freeze({ abort: 'aborted', error: 'error' });
const TASK_NOTIFICATION = /^<task-notification>/;

function turnEndReasonOf(hostEvent, payload) {
  if (hostEvent === QUERY_END) return QUERY_END_REASONS[payload.reason] ?? 'unknown';
  return hostEvent === STOP_FAILURE ? 'error' : 'answer';
}

const text = (value) => (typeof value === 'string' ? value : '');
const isHostPrompt = (payload) => TASK_NOTIFICATION.test(text(payload.prompt).trimStart());
const hostEventOf = (payload, context) => context?.hostEvent ?? payload.hook_event_name;

export default defineProfile({
  name: 'qoder',
  label: 'Qoder',
  events: {
    SessionStart: EVENTS.SESSION_START,
    UserPromptSubmit: EVENTS.PROMPT,
    PreToolUse: EVENTS.BEFORE_EDIT,
    PostToolUse: EVENTS.TOOL_RESULT,
    PostToolUseFailure: EVENTS.TOOL_RESULT,
    [STOP]: EVENTS.TURN_END,
    [STOP_FAILURE]: EVENTS.TURN_END,
    [QUERY_END]: EVENTS.TURN_END,
    SessionEnd: EVENTS.SESSION_END,
  },
  payload: {
    turnId: (payload) => text(payload.request_set_id) || text(payload.parent_request_set_id) || null,
    isIgnored: (payload) => Boolean(payload.agent_id) || isHostPrompt(payload),
    // Stop names no model, and the distillation runs on the person's default.
    model: () => ({ model: 'default' }),
  },
  reply: {
    // A blocked prompt reaches no model, and the next request carries only a marker naming the command; the TUI draws
    // the system message.
    command: (result) => ({ decision: 'block', reason: result.text, systemMessage: result.text }),
    // Qoder shows a Stop hook's systemMessage to the person only, and ignores what StopFailure and QueryEnd answer.
    turnEnd: (ended, hostEvent) => {
      const line = hostEvent === STOP ? endedTurnSummaryOf(ended, { reason: 'answer' }) : null;
      return line ? { systemMessage: line } : {};
    },
  },
  evidence: { toolNote: toolNoteOf, editedFiles: editedFilesOf },
  turnEnd: {
    reason: (payload, context) => turnEndReasonOf(hostEventOf(payload, context), payload),
    unclosed: { settleMs: 0, as: 'aborted' },
  },
  commands: { entry: 'intercept', parse: (payload, hostEvent, { prompt }) => promptCommandOf(prompt) },
  // UserPromptSubmit also answers the evolver-* commands, which may run the evolver CLI for ten minutes.
  budgets: { prompt: 660_000 },
  model: headlessQodercli,
});

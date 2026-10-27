// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { EVENTS } from '../../lib/agent/events.js';
import { defineProfile } from '../../lib/agent/profile.js';
import { endedTurnSummaryOf } from '../../lib/turn-summary.js';
import { promptCommandOf } from './commands.js';
import { editedFilesOf, toolNoteOf } from './evidence.js';
import { headlessQodercli } from './headless.js';

// A turn that failed on a model error ends with StopFailure; one the person interrupted ends with no hook, so the
// next prompt closes it as aborted. A background command's completion comes back as a `<task-notification>` prompt
// Qoder submits itself, which is no turn of the person's.

const STOP_FAILURE = 'StopFailure';
const TASK_NOTIFICATION = /^<task-notification>/;

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
    Stop: EVENTS.TURN_END,
    [STOP_FAILURE]: EVENTS.TURN_END,
    SessionEnd: EVENTS.SESSION_END,
  },
  payload: {
    turnId: (payload) => text(payload.request_set_id) || text(payload.parent_request_set_id) || null,
    isIgnored: (payload) => Boolean(payload.agent_id) || isHostPrompt(payload),
    // Stop names the session's model once Qoder knows it; the distillation runs on the person's default either way.
    model: (payload) => ({ model: text(payload.model) || 'default' }),
  },
  reply: {
    // A blocked prompt reaches no model and leaves nothing in the conversation; the TUI draws the system message.
    command: (result) => ({ decision: 'block', reason: result.text, systemMessage: result.text }),
    // Qoder shows a Stop hook's systemMessage to the person only, and ignores what a StopFailure hook answers.
    turnEnd: (ended, hostEvent) => {
      const line = hostEvent === STOP_FAILURE ? null : endedTurnSummaryOf(ended, { reason: 'answer' });
      return line ? { systemMessage: line } : {};
    },
  },
  evidence: { toolNote: toolNoteOf, editedFiles: editedFilesOf },
  turnEnd: {
    reason: (payload, context) => (hostEventOf(payload, context) === STOP_FAILURE ? 'error' : 'answer'),
    unclosed: { settleMs: 0, as: 'aborted' },
  },
  commands: { entry: 'intercept', parse: (payload, hostEvent, { prompt }) => promptCommandOf(prompt) },
  // UserPromptSubmit also answers the evolver-* commands, which may run the evolver CLI for ten minutes.
  budgets: { prompt: 660_000 },
  model: headlessQodercli,
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { EVENTS } from '../../lib/agent/events.js';
import { defineProfile } from '../../lib/agent/profile.js';
import { editedFileOf, toolNoteOf } from './evidence.js';
import { completionOf, cursorAgentArguments, sessionModelOf } from './headless.js';

const text = (value) => (typeof value === 'string' ? value : '');
const firstWorkspaceRoot = ({ workspace_roots: roots }) => (Array.isArray(roots) ? text(roots[0]) : '') || null;
// An inline edit (Cmd-K) also raises beforeSubmitPrompt, but names no composer_mode and drops added context.
const isInlineEdit = (payload) => typeof payload.prompt === 'string' && typeof payload.composer_mode !== 'string';

const STOP_REASONS = { completed: 'answer', aborted: 'aborted', error: 'error' };

export default defineProfile({
  name: 'cursor',
  label: 'Cursor',
  events: {
    sessionStart: EVENTS.SESSION_START,
    beforeSubmitPrompt: EVENTS.PROMPT,
    preToolUse: EVENTS.BEFORE_EDIT,
    postToolUse: EVENTS.TOOL_RESULT,
    postToolUseFailure: EVENTS.TOOL_RESULT,
    afterFileEdit: EVENTS.TOOL_RESULT,
    afterAgentResponse: EVENTS.TOOL_RESULT,
    stop: EVENTS.TURN_END,
    sessionEnd: EVENTS.SESSION_END,
  },
  payload: {
    sessionId: (payload) => text(payload.conversation_id) || text(payload.session_id) || null,
    turnId: (payload) => text(payload.generation_id) || null,
    projectDir: firstWorkspaceRoot,
    isSubagent: isInlineEdit,
    model: sessionModelOf,
  },
  reply: {
    context: (strategy) => (strategy ? { continue: true, additional_context: strategy } : {}),
    notice: (notice) => (notice ? { additional_context: notice } : {}),
    command: (result) => (result.forAgent
      ? { continue: true, additional_context: result.text }
      : { continue: false, user_message: result.text }),
    // A generation Cursor submits again gets its turn's strategy again instead of closing that turn as an error.
    lifetime: 'call',
  },
  evidence: { toolNote: toolNoteOf, editedFile: editedFileOf },
  turnEnd: {
    reason: (payload) => STOP_REASONS[payload.status] ?? 'error',
    // Cursor sends the next prompt without waiting for the last turn's stop.
    unclosed: { settleMs: 3_000, as: 'error' },
  },
  commands: { entry: 'intercept' },
  // beforeSubmitPrompt also answers the /evolver-* commands, which may run the evolver CLI for ten minutes.
  budgets: { prompt: 660_000 },
  owner: { ancestor: /cursor/i },
  model: { kind: 'cli', command: () => 'cursor-agent', args: cursorAgentArguments, parse: completionOf },
});

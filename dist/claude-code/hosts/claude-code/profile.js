// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { EVENTS, REASONS } from '../../lib/agent/events.js';
import { defineProfile } from '../../lib/agent/profile.js';
import { isPersonPrompt } from '../../lib/recall.js';
import { endedTurnSummaryOf } from '../../lib/turn-summary.js';
import { editedFilesOf, toolNoteOf } from './tool-calls.js';

// Claude Code runs the plugin as a hooks module (`dist/hooks/register.ts`), where there is no Node. The module
// starts `bin/relay.mjs claude-code` for the session and sends it these host events, each a Claude Code event with
// the session's id, folder and model beside it: `turn.start` with the `origin` of the prompt that started the turn,
// `tool.call.before` and `tool.call` around each tool call (`call` the event, `result` what it resolved to). A turn
// nobody typed (a task notification) is recalled for nothing but its work still counts; a subagent's turn end is not
// the session's. `turn.start` holds no model call, so a recall gains nothing by waiting there: every strategy is a
// late one, added when it lands and booked by the first model step that carries it (budget 0). The
// module applies the answers: `append` adds hidden text to the conversation (to a `tool.call`, as that call's result
// context, which the model reads next), `toast` and `submit` show a notice and send a prompt, `text` and `context`
// answer a command.

const text = (value) => (typeof value === 'string' ? value : '');

const CLAUDE_REASONS = new Set(REASONS.filter((reason) => reason !== 'unknown'));

export default defineProfile({
  name: 'claude-code',
  label: 'Claude Code',
  channel: 'relay',
  events: {
    'session.start': EVENTS.SESSION_START,
    'turn.start': EVENTS.PROMPT,
    'tool.call.before': EVENTS.BEFORE_EDIT,
    'tool.call': EVENTS.TOOL_RESULT,
    'turn.complete': EVENTS.TURN_END,
    'session.end': EVENTS.SESSION_END,
    'command.run': EVENTS.COMMAND,
  },
  payload: {
    sessionId: (payload) => text(payload.session_id) || null,
    turnId: (payload) => text(payload.turn_id) || null,
    prompt: (payload) => (isPersonPrompt(payload.origin) ? text(payload.text) : ''),
    projectDir: (payload) => text(payload.cwd) || null,
    isIgnored: (payload) => Boolean(payload.agent_id),
    model: (payload) => text(payload.model) || null,
  },
  reply: {
    context: (strategy) => (strategy ? { append: strategy } : {}),
    notice: (notice) => (notice ? { toast: notice } : {}),
    empty: () => ({}),
    command: (result) => (result.forAgent
      ? { submit: result.text }
      : { text: result.text, ...(result.ok === false && { exitCode: 1 }), ...(result.strategy && { context: [result.strategy.text] }) }),
    turnEnd: (ended, hostEvent, payload) => {
      const line = endedTurnSummaryOf(ended, payload);
      return line ? { text: line } : {};
    },
    late: (answer, late) => ({ ...answer, late }),
    lifetime: 'turn',
    toolResultContext: true,
  },
  evidence: { toolNote: toolNoteOf, editedFiles: editedFilesOf },
  turnEnd: {
    reason: (payload) => (CLAUDE_REASONS.has(payload.reason) ? payload.reason : 'error'),
    answer: (payload) => text(payload.answer),
  },
  commands: {
    entry: 'intercept',
    parse: (payload, hostEvent) => (hostEvent === 'command.run' && payload.command ? { name: payload.command, args: text(payload.args).trim() } : null),
    answerReachesModel: true,
  },
  budgets: { prompt: 0 },
  model: { kind: 'sdk' },
  legacy: [{ ledgers: /^claude-code-injected-[0-9a-f]{16}\.json$/ }],
});

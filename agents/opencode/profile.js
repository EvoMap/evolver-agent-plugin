// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { EVENTS } from '../../lib/agent/events.js';
import { defineProfile } from '../../lib/agent/profile.js';
import { isPersonSession } from './sessions.js';
import { editedFilesOf, toolNoteOf } from './tools.js';
import { modelOf, turnEndReason } from './turn-end.js';

// OpenCode loads the plugin into its own process (`dist/server.mjs`, `dist/tui.mjs`). Those entries raise these
// host events from OpenCode's callbacks and apply the answers to OpenCode's output objects. `session.start` is a
// session's first prompt in this OpenCode instance, `session.idle` a turn's end with what the entry saw of it, and
// `tui.command` a palette command of the TUI plugin.

const text = (value) => (typeof value === 'string' ? value : '');

const personText = (parts) => (parts ?? [])
  .filter((part) => part?.type === 'text' && !part.synthetic && text(part.text).trim())
  .map((part) => part.text.trim())
  .join('\n');

const strategyPart = (strategy) => ({ part: { type: 'text', text: strategy, synthetic: true } });

export default defineProfile({
  name: 'opencode',
  label: 'OpenCode',
  channel: 'plugin',
  events: {
    'session.start': EVENTS.SESSION_START,
    'chat.message': EVENTS.PROMPT,
    'tool.execute.before': EVENTS.BEFORE_EDIT,
    'tool.execute.after': EVENTS.TOOL_RESULT,
    'session.idle': EVENTS.TURN_END,
    'session.deleted': EVENTS.SESSION_END,
    dispose: EVENTS.SESSION_END,
    'command.execute.before': EVENTS.COMMAND,
    'tui.command': EVENTS.COMMAND,
  },
  payload: {
    sessionId: (payload) => text(payload.sessionID) || null,
    turnId: (payload) => text(payload.turnID) || null,
    prompt: (payload) => personText(payload.parts),
    projectDir: (payload) => text(payload.directory) || null,
    isSubagent: (payload) => !isPersonSession(payload.session),
    model: (payload) => modelOf(payload.lastAssistant),
  },
  reply: {
    context: (strategy) => (strategy ? strategyPart(strategy) : {}),
    notice: (notice) => ({ toast: notice }),
    empty: () => ({}),
    command: (result, hostEvent, payload) => ({
      ok: result.ok,
      text: result.text,
      ...(result.strategy && strategyPart(result.strategy.text)),
    }),
    turnEnd: () => ({}),
    lifetime: 'turn',
  },
  evidence: { toolNote: toolNoteOf, editedFiles: editedFilesOf },
  turnEnd: {
    reason: turnEndReason,
    answer: (payload) => text(payload.answer),
  },
  commands: {
    entry: 'prompt',
    answerReachesModel: true,
    parse: (payload) => (payload.command ? { name: payload.command, args: text(payload.arguments).trim() } : null),
  },
  model: { kind: 'sdk' },
});

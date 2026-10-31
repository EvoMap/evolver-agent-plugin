// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { join } from 'node:path';

import { EVENTS } from '../../lib/agent/events.js';
import { defineProfile } from '../../lib/agent/profile.js';
import { editedFilesOf, toolNoteOf } from './evidence.js';
import { dataDirOf } from './paths.js';
import { headlessMiniMax } from './headless.js';
import { stateDirOf } from './paths.js';
import { isBackgroundCommand, promptCommandOf } from './commands.js';
import { modelRecord, sessionModelOf } from './model.js';
import { endedTurnSummaryOf } from '../../lib/turn-summary.js';

export default defineProfile({
  name: 'minimax', label: 'MiniMax Code',
  events: { SessionStart: EVENTS.SESSION_START, UserPromptSubmit: EVENTS.PROMPT, PreToolUse: EVENTS.BEFORE_EDIT, PostToolUse: EVENTS.TOOL_RESULT, Stop: EVENTS.TURN_END, SessionEnd: EVENTS.SESSION_END },
  payload: { model: sessionModelOf },
  modelRecord,
  commands: { entry: 'intercept', parse: promptCommandOf, background: isBackgroundCommand },
  reply: {
    command: result => ({ decision: 'block', reason: result.text, systemMessage: result.text }),
    turnEnd: ended => { const line = endedTurnSummaryOf(ended, { reason: 'answer' }); return line ? { systemMessage: line } : {}; },
  },
  evidence: { toolNote: toolNoteOf, editedFiles: editedFilesOf },
  turnEnd: {
    unclosed: { settleMs: 0, as: 'error' },
    statusRecord: {
      file: env => join(dataDirOf(env), 'v2', 'sqlite', 'runtime-state.sqlite'),
      // shortcut: read the v2 terminal status until MiniMax emits a native failed/cancelled hook.
      query: 'SELECT status FROM local_runtime_turn_ingress WHERE session_id = ? AND turn_id = ?',
    },
  },
  budgets: { prompt: 10_000, sessionEnd: 3_000 },
  owner: 'parent',
  model: headlessMiniMax,
  stateDir: stateDirOf,
  settingsFile: env => join(stateDirOf(env), 'minimax-settings.json'),
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { EVENTS } from '../../lib/agent/events.js';
import { defineProfile } from '../../lib/agent/profile.js';
import { AGENT_NAME, commandAnswer, emptyAnswer, evolverCommandOf, sessionOfCommand } from './commands.js';
import { headlessCodebuddy } from './headless.js';
import { EDIT_TOOLS, answerOf, editedPathOf, latestTurnOf, modelOf, turnActivityOf, turnMarkOf, turnRecordsOf } from './transcript.js';

const FINAL_STOP_REASONS = { completed: 'answer', interrupted: 'aborted', cancelled: 'aborted', failed: 'error' };

function editedFileOf(payload) {
  const file = EDIT_TOOLS.includes(payload.tool_name) ? editedPathOf(payload.tool_input) : null;
  return file && typeof payload.cwd === 'string' && payload.cwd ? resolve(payload.cwd, file) : file;
}

// Hooks get the plugin's data folder from the host and commands from their script line; anything else falls back.
const stateDirOf = (env) => env.CODEBUDDY_PLUGIN_DATA || join(env.HOME || env.USERPROFILE || homedir(), '.evolver', 'workbuddy-hooks');

export default defineProfile({
  name: AGENT_NAME,
  label: 'WorkBuddy',
  events: {
    SessionStart: EVENTS.SESSION_START,
    UserPromptSubmit: EVENTS.PROMPT,
    PreToolUse: EVENTS.BEFORE_EDIT,
    FinalStop: EVENTS.TURN_END,
    SessionEnd: EVENTS.SESSION_END,
    Command: EVENTS.COMMAND,
    AgentGene: EVENTS.AGENT_GENE,
  },
  payload: {
    // SessionStart carries no cwd; the host sets the project in every hook's environment.
    projectDir: (payload, context) => (typeof payload.cwd === 'string' && payload.cwd) || context?.env?.CODEBUDDY_PROJECT_DIR || null,
    model: (payload, context) => modelOf(latestTurnOf(context)),
  },
  reply: { command: commandAnswer, empty: emptyAnswer },
  evidence: {
    toolNote: () => null,
    editedFile: editedFileOf,
    turnStart: (payload, context) => turnMarkOf(context),
    turnRecord: (payload, context) => turnActivityOf(turnRecordsOf(context)),
  },
  turnEnd: {
    reason: (payload) => FINAL_STOP_REASONS[payload.final_stop_reason ?? 'completed'] ?? 'error',
    answer: (payload, context) => answerOf(latestTurnOf(context)),
  },
  commands: {
    entry: 'inline-script',
    parse: (payload, hostEvent, { prompt }) => evolverCommandOf(prompt),
    sessionOf: sessionOfCommand,
  },
  budgets: { prompt: 8_000 },
  model: headlessCodebuddy,
  stateDir: stateDirOf,
});

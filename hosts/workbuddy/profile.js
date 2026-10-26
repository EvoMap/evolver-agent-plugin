// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { EVENTS } from '../../lib/agent/events.js';
import { defineProfile } from '../../lib/agent/profile.js';
import { AGENT_NAME, argumentsText, evolverCommandOf, scriptAnswer, sessionOfCommand } from './commands.js';
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
  },
  payload: {
    // An error-recovery input the host sends mid-turn is no prompt of the person's.
    isIgnored: (payload) => Boolean(payload.agent_id) || payload.is_internal_continuation === true,
    // SessionStart carries no cwd; the host sets the project in every hook's environment.
    projectDir: (payload, context) => (typeof payload.cwd === 'string' && payload.cwd) || context?.env?.CODEBUDDY_PROJECT_DIR || null,
    model: (payload, context) => modelOf(latestTurnOf(context)),
  },
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
    scriptArgs: argumentsText,
    scriptAnswer,
  },
  budgets: { prompt: 8_000 },
  model: headlessCodebuddy,
  stateDir: stateDirOf,
  // 0.3.0 named its files without the agent, and kept a session's id and owner on its ledger entries.
  legacy: [
    { sessions: /^session-[0-9a-f]{16}\.json$/ },
    { rename: /^(?:edits-[0-9a-f]{16}\.jsonl|reports-queue\.jsonl|reports-outbox\.json|retention-pending\.jsonl|engine\.json|engine-announced\.json|engine)$/ },
  ],
});

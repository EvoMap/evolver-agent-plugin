// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { EVENTS, REASONS } from '../../lib/agent/events.js';
import { defineProfile } from '../../lib/agent/profile.js';
import { withoutSecrets } from '../../lib/redact.js';
import { editedFilesOf, toolNoteOf } from './tools.js';

const text = (value) => typeof value === 'string' ? value : '';
const id = (value) => text(value).trim() && value.length <= 256 ? value : null;
const TURN_EVENTS = new Set(['before_agent_start', 'tool_call', 'tool_start', 'tool_result', 'agent_settled']);
const stateDirOf = (env) => {
  const root = env.STEP_CODING_AGENT_DIR ?? join(env.USERPROFILE || env.HOME || homedir(), '.stepcode', 'agent');
  if (!isAbsolute(root)) throw new Error('Step Code requires an absolute STEP_CODING_AGENT_DIR');
  return join(root, 'evolver-plugin');
};

export default defineProfile({
  name: 'stepcode', label: 'Step Code', channel: 'plugin', model: { kind: 'sdk' },
  events: {
    session_start: EVENTS.SESSION_START, before_agent_start: EVENTS.PROMPT,
    tool_call: EVENTS.BEFORE_EDIT, tool_start: EVENTS.TOOL_RESULT, tool_result: EVENTS.TOOL_RESULT,
    agent_settled: EVENTS.TURN_END, session_shutdown: EVENTS.SESSION_END, command: EVENTS.COMMAND,
  },
  payload: {
    sessionId: (payload) => id(payload.sessionId),
    turnId: (payload) => id(payload.turnId),
    prompt: (payload) => text(payload.prompt),
    projectDir: (payload) => isAbsolute(text(payload.cwd)) ? payload.cwd : null,
    model: (payload) => payload.model ?? null,
    isIgnored: (payload, { hostEvent }) => !isAbsolute(text(payload.cwd)) || (TURN_EVENTS.has(hostEvent) && !id(payload.turnId)),
  },
  reply: {
    context: (strategy) => strategy ? { strategy } : {},
    empty: () => ({}), notice: (notice) => notice ? { notice } : {},
    command: (result) => result, turnEnd: () => ({}), lifetime: 'turn', toolResultContext: true,
  },
  evidence: { toolNote: toolNoteOf, editedFiles: editedFilesOf, turnStart: (payload) => payload.model ?? null },
  turnEnd: {
    reason: (payload) => REASONS.includes(payload.reason) ? payload.reason : 'unknown',
    answer: (payload) => withoutSecrets(text(payload.answer)),
    modelOf: (row, started) => started,
  },
  commands: {
    entry: 'cli-only',
    parse: (payload) => text(payload.command) ? { name: payload.command, args: text(payload.arguments).trim() } : null,
  },
  stateDir: stateDirOf,
  settingsFile: (env) => join(stateDirOf(env), 'stepcode-settings.json'),
});

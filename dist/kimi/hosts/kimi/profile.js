// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { join } from 'node:path';

import { defineProfile } from '../../lib/agent/profile.js';
import { EVENTS } from '../../lib/agent/events.js';
import { kimiEvidence } from './evidence.js';
import { headlessKimi, modelOf } from './model.js';
import { kimiPayload } from './payload.js';
import { kimiHomeOf, nativeSessionOf, stateDirOf } from './paths.js';
import { taskIdsOf, turnStatusOf } from './transcript.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const workspacesOf = (index) => index?.version === 1 && isObject(index.workspaces)
  ? Object.entries(index.workspaces).map(([id, workspace]) => [id, workspace?.root]) : null;
const promptReply = (message, event) => message && event === 'UserPromptSubmit' ? { message } : {};

const sessionLog = Object.freeze({
  root: kimiHomeOf, workspaceIndex: 'workspaces.json', workspacesOf, nativeSessionOf,
  sessionDir: (workspaceId, sessionId) => join('sessions', workspaceId, sessionId),
  logFile: 'agents/main/wire.jsonl',
  tasksDir: (sessionDir) => join(sessionDir, 'agents', 'main', 'tasks'),
  taskIds: taskIdsOf, decode: turnStatusOf,
});

export default defineProfile({
  name: 'kimi', label: 'Kimi Code',
  events: {
    SessionStart: EVENTS.SESSION_START, UserPromptSubmit: EVENTS.PROMPT,
    // Kimi names a turn only once it runs, and writes its end to the session log, sometimes after the last hook.
    TurnStarted: EVENTS.TURN_START, Stop: EVENTS.TURN_START, StopFailure: EVENTS.TURN_START, Interrupt: EVENTS.TURN_START,
    Notification: EVENTS.TURN_START,
    PreToolUse: EVENTS.BEFORE_EDIT,
    SessionEnd: EVENTS.SESSION_END,
  },
  payload: kimiPayload,
  evidence: kimiEvidence,
  reply: { context: promptReply, notice: promptReply, toolResultContext: false },
  commands: { entry: 'cli-only', parse: () => null },
  modelRecord: sessionLog,
  turnEnd: {
    modelOf,
    statusRecord: { ...sessionLog, confirmCompletion: true },
    unclosed: { settleMs: 0, as: 'error' },
  },
  budgets: { prompt: 6_000, sessionEnd: 2_000 },
  owner: { ancestor: /^kimi(?:[- ]code)?(?:\.exe)?$/i },
  windowsAncestry: true,
  drainWindowsHandles: true,
  model: headlessKimi,
  stateDir: stateDirOf,
  settingsFile: (env) => join(stateDirOf(env), 'kimi-settings.json'),
});

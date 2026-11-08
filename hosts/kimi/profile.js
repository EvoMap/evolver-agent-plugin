// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { join } from 'node:path';

import { defineProfile } from '../../lib/agent/profile.js';
import { EVENTS } from '../../lib/agent/events.js';
import { kimiEvidence } from './evidence.js';
import { headlessKimi } from './model.js';
import { kimiPayload } from './payload.js';
import { kimiHomeOf, nativeSessionIdOf, projectDirOf, stateDirOf } from './paths.js';
import { decodeNativeFacts, taskIdsOf } from './transcript.js';

const promptReply = (message, event) => message && event === 'UserPromptSubmit' ? { message } : {};
const reasons = { completed: 'answer', failed: 'error', cancelled: 'aborted', interrupted: 'aborted' };
const terminalOf = context => context?.nativeFacts?.status === 'ok' && context.nativeFacts.schemaSupported ? context.nativeFacts.terminal : null;

export default defineProfile({
  name: 'kimi', label: 'Kimi Code',
  events: {
    SessionStart: EVENTS.SESSION_START, UserPromptSubmit: EVENTS.PROMPT,
    PreToolUse: EVENTS.BEFORE_EDIT, PostToolUse: EVENTS.TOOL_RESULT, PostToolUseFailure: EVENTS.TOOL_RESULT,
    SessionEnd: EVENTS.SESSION_END,
  },
  payload: kimiPayload,
  native: {
    events: ['TurnStarted', 'Stop', 'StopFailure', 'Interrupt', 'TaskStarted', 'Notification'],
    root: kimiHomeOf, workspaceIndex: 'workspaces.json', sessionId: nativeSessionIdOf, projectDir: projectDirOf, agent: 'main',
    reference: payload => ({ session_id: nativeSessionIdOf(payload), cwd: projectDirOf(payload) }),
    tasksRoot: (env, sessionDir) => join(sessionDir, 'agents', 'main', 'tasks'),
    taskIds: taskIdsOf, decode: decodeNativeFacts,
  },
  evidence: kimiEvidence,
  reply: { context: promptReply, notice: promptReply, toolResultContext: false },
  commands: { entry: 'cli-only', parse: () => null },
  turnEnd: {
    reason: (payload, context) => reasons[terminalOf(context)?.reason] ?? 'unknown',
    answer: (payload, context) => terminalOf(context)?.answer ?? '',
    unclosed: { settleMs: 0, as: 'error' },
  },
  budgets: { prompt: 6_000, sessionEnd: 2_000 },
  owner: { ancestor: /^kimi(?:[- ]code)?(?:\.exe)?$/i },
  windowsAncestry: true,
  drainWindowsHandles: true,
  model: headlessKimi,
  stateDir: stateDirOf,
  settingsFile: env => join(stateDirOf(env), 'kimi-settings.json'),
});

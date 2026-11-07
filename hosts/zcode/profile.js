// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { isAbsolute, join } from 'node:path';

import { EVENTS } from '../../lib/agent/events.js';
import { defineProfile } from '../../lib/agent/profile.js';
import { withoutSecrets } from '../../lib/redact.js';
import { databaseOf, headlessZCode, homeOf, modelOf, modelRecord } from './model.js';

const id = (value) => typeof value === 'string' && value.trim() && value.length <= 256 ? value : null;
const sessionId = (payload) => id(payload.sessionId ?? payload.session_id);
const turnId = (payload) => id(payload.turnId);

function toolNote(payload, { hostEvent }) {
  if (hostEvent === 'Stop') {
    const answer = payload.responseText ?? payload.last_assistant_message;
    return typeof answer === 'string' ? { kind: 'answer', text: withoutSecrets(answer).slice(0, 3_000) } : null;
  }
  const callId = id(payload.toolCallId ?? payload.tool_use_id);
  const input = payload.toolInput ?? payload.tool_input;
  if ((payload.toolName ?? payload.tool_name) !== 'Bash' || !callId || typeof input?.command !== 'string' || !input.command.trim()) return null;
  const command = withoutSecrets(input.command);
  if (hostEvent === 'PreToolUse') return { kind: 'shell', callId, command, running: true };
  const result = payload.toolResponse ?? payload.tool_response;
  const exit = result?.exitCode;
  const exited = hostEvent === 'PostToolUse' && Number.isInteger(exit)
    && result.status === (exit === 0 ? 'completed' : 'failed') && !result.cancelled && !result.interrupted && !result.timedOut;
  return { kind: 'shell', callId, command, exit: exited ? exit : null };
}

export default defineProfile({
  name: 'zcode',
  label: 'ZCode',
  model: headlessZCode,
  modelRecord,
  events: {
    SessionStart: EVENTS.SESSION_START, UserPromptSubmit: EVENTS.PROMPT,
    PreToolUse: EVENTS.TOOL_RESULT, PostToolUse: EVENTS.TOOL_RESULT, PostToolUseFailure: EVENTS.TOOL_RESULT,
    // Stop runs before native completion and can be followed by another model step.
    Stop: EVENTS.TOOL_RESULT,
  },
  payload: {
    sessionId,
    turnId,
    isIgnored: (payload, { hostEvent }) => Boolean(payload.agentId || payload.agent_id)
      || (!turnId(payload) && hostEvent !== 'SessionStart')
      || !isAbsolute(typeof payload.cwd === 'string' ? payload.cwd : ''),
    transcriptPath: () => null,
  },
  evidence: { toolNote, editedFiles: () => [] },
  turnEnd: {
    modelOf,
    statusRecord: {
      confirmCompletion: true,
      file: databaseOf,
      // shortcut: use the version-checked native status schema until ZCode exposes a post-turn hook.
      query: `SELECT COALESCE((
        SELECT CASE status WHEN 'cancelled' THEN 'aborted' WHEN 'error' THEN 'failed' WHEN 'running' THEN 'pending' ELSE status END
        FROM turn_usage WHERE session_id = ? AND turn_id = ? AND (status = 'running' OR completed_at IS NOT NULL)
      ), 'pending') AS status`,
    },
  },
  owner: 'spawner',
  stateDir: (env) => isAbsolute(env.ZCODE_PLUGIN_DATA || '') ? env.ZCODE_PLUGIN_DATA : join(homeOf(env), '.zcode', 'cli', 'evolver-plugin'),
});

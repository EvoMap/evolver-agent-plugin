// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { nativeTurnIdOf } from './transcript.js';
import { projectDirOf, sessionIdOf } from './paths.js';

const text = (value) => typeof value === 'string' ? value : '';
const localClients = new Set(['kimi_code_cli', 'kimi_code_desktop']);

export const kimiPayload = Object.freeze({
  sessionId: sessionIdOf,
  projectDir: projectDirOf,
  prompt: (payload) => Array.isArray(payload.prompt)
    ? payload.prompt.filter((part) => part?.type === 'text').map((part) => text(part.text)).join('\n').trim()
    : text(payload.prompt).trim(),
  turnId: (payload) => payload.hook_event_name === 'UserPromptSubmit' ? null : nativeTurnIdOf(payload.turn_id),
  isIgnored: (payload) => payload.is_steer === true
    || Boolean(payload.agent_id && payload.agent_id !== 'main')
    || (payload.origin_kind !== undefined && payload.origin_kind !== 'user')
    || !localClients.has(payload.client_type),
  // SessionStart.model is a global default, not the model a turn ran on; that is read from the session log.
  model: () => null,
});

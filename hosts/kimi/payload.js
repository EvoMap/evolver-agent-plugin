// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { nativeTurnIdOf } from './transcript.js';
import { projectDirOf, sessionIdOf } from './paths.js';

const text = (value) => typeof value === 'string' ? value : '';
const toolEvents = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

export const kimiPayload = Object.freeze({
  sessionId: sessionIdOf,
  projectDir: projectDirOf,
  prompt: (payload) => Array.isArray(payload.prompt)
    ? payload.prompt.filter((part) => part?.type === 'text').map((part) => text(part.text)).join('\n').trim()
    : '',
  turnId: (payload, context = {}) => {
    if (payload.hook_event_name === 'UserPromptSubmit') return null;
    if (toolEvents.has(payload.hook_event_name)) return nativeTurnIdOf(context.nativeFacts?.toolTurnId);
    return nativeTurnIdOf(payload.turn_id) ?? nativeTurnIdOf(context.nativeFacts?.bind?.turnId);
  },
  isIgnored: (payload) => payload.is_steer === true
    || Boolean(payload.agent_id && payload.agent_id !== 'main')
    || (payload.origin_kind !== undefined && payload.origin_kind !== 'user')
    || payload.client_type !== 'kimi_code_cli',

  // SessionStart.model is a global default, not the selected native profile binding.
  model: (payload, context = {}) => context.nativeFacts?.modelHint ?? null,
});

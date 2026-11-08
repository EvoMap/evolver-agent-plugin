// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// What most command-hook hosts share, since they copied Claude Code's hook protocol: the payload's field names
// and `hookSpecificOutput.additionalContext` as the way context reaches the model.

const text = (value) => (typeof value === 'string' ? value : '');

export const claudeStylePayload = Object.freeze({
  sessionId: (payload) => text(payload.session_id) || null,
  turnId: (payload) => text(payload.turn_id) || null,
  prompt: (payload) => text(payload.prompt).trim(),
  projectDir: (payload) => text(payload.cwd) || null,
  isIgnored: (payload) => Boolean(payload.agent_id),
  model: (payload) => payload.model ?? null,
});

const contextOutput = (context, hostEvent) => (context ? { hookSpecificOutput: { hookEventName: hostEvent, additionalContext: context } } : {});

export const additionalContextReply = Object.freeze({
  context: contextOutput,
  notice: contextOutput,
  empty: () => ({}),
  command: (result, hostEvent) => contextOutput(result.text, hostEvent),
  turnEnd: () => ({}),
  lifetime: 'turn',
});

export const hookTurnEnd = Object.freeze({
  reason: () => 'answer',
  answer: (payload) => text(payload.last_assistant_message),
  unclosed: Object.freeze({ settleMs: 0, as: 'error' }),
});

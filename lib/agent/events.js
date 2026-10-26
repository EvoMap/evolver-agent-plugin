// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

/** The canonical events every host event is translated into; nothing past the driver sees a host's own. */
export const EVENTS = Object.freeze({
  SESSION_START: 'sessionStart',
  PROMPT: 'prompt',
  TOOL_RESULT: 'toolResult',
  BEFORE_EDIT: 'beforeEdit',
  TURN_END: 'turnEnd',
  SESSION_END: 'sessionEnd',
  COMMAND: 'command',
  AGENT_GENE: 'agentGene',
});

export const CHANNELS = Object.freeze({ HOOK: 'hook', PLUGIN: 'plugin', MCP: 'mcp' });

/** How a turn ended, in the vocabulary of lib/turn-outcomes.js; 'unknown' leaves the turn open. */
export const REASONS = Object.freeze(['answer', 'aborted', 'refusal', 'error', 'unknown']);

/** How a typed `/evolver-…` command reaches the plugin on a host. */
export const COMMAND_ENTRIES = Object.freeze({
  INTERCEPT: 'intercept',
  INLINE_SCRIPT: 'inline-script',
  PROMPT: 'prompt',
  TOOL: 'tool',
  CLI_ONLY: 'cli-only',
});

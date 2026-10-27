// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// UserPromptSubmit sees the prompt as typed, before Qoder expands a command file, so the hook answers the plugin's
// commands itself. Qoder registers them as `/evolver-plugin:evolver-status` and resolves `/evolver-status` too.

import { commandCatalog } from '../../lib/agent/commands.js';

export const PLUGIN_NAME = 'evolver-plugin';

const COMMAND_NAMES = Object.freeze(commandCatalog.map((command) => command.name));
const TAKES_NO_ARGUMENTS = Object.freeze(commandCatalog.filter((command) => !command.hint).map((command) => command.name));
const TYPED = new RegExp(`^/(?:${PLUGIN_NAME}:)?(evolver-[a-z]+)(?:\\s+([\\s\\S]*))?$`);

/** The command a prompt is, `{ name, args }` with its raw argument text, or null for any other prompt. */
export function promptCommandOf(prompt) {
  const match = TYPED.exec(String(prompt ?? '').trim());
  if (!match || !COMMAND_NAMES.includes(match[1])) return null;
  const args = (match[2] ?? '').trim();
  return TAKES_NO_ARGUMENTS.includes(match[1]) && args ? null : { name: match[1], args };
}

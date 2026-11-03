// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// A command is typed into the prompt box, with or without a leading `/`, and the prompt hook answers it. Only a
// prompt that is exactly a command counts: one that merely starts with a command's name, or has text after a command
// that takes none, stays a prompt. A plugin namespace before the name (`/evolver-plugin:evolver-status`) is dropped.
// grok discards what a prompt hook adds, so a command for the agent reaches it only as grok's own slash command, from
// the plugin's command file: it counts only typed with its slash.

import { commandCatalog, parsePromptCommand } from '../../lib/agent/commands.js';

export const COMMAND_NAMES = Object.freeze(commandCatalog.map((command) => command.name));
export const FOR_AGENT = Object.freeze(commandCatalog.filter((command) => command.forAgent).map((command) => command.name));

export function promptCommandOf(prompt) {
  return parsePromptCommand(prompt, { namespace: true, slashForAgent: true });
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// A command is typed into the prompt box, with or without a leading `/`, and the prompt hook answers it. Only a
// prompt that is exactly a command counts: one that merely starts with a command's name, or has text after a command
// that takes none, stays a prompt. A plugin namespace before the name (`/evolver-plugin:evolver-status`) is dropped.
// grok discards what a prompt hook adds, so a command for the agent reaches it only as grok's own slash command, from
// the plugin's command file: it counts only typed with its slash.

import { commandCatalog } from '../../lib/agent/commands.js';

export const COMMAND_NAMES = Object.freeze(commandCatalog.map((command) => command.name));
const TAKES_NO_ARGUMENTS = Object.freeze(commandCatalog.filter((command) => !command.hint).map((command) => command.name));
export const FOR_AGENT = Object.freeze(commandCatalog.filter((command) => command.forAgent).map((command) => command.name));

const TYPED = /^(\/?)(?:[\w-]+:)?(evolver-[a-z]+)(?:\s+([\s\S]*))?$/;

/** The command a prompt is, `{ name, args }` with its raw argument text, or null for any other prompt. */
export function promptCommandOf(prompt) {
  const match = TYPED.exec(String(prompt ?? '').trim());
  if (!match || !COMMAND_NAMES.includes(match[2])) return null;
  const [, slash, name] = match;
  const args = (match[3] ?? '').trim();
  if (FOR_AGENT.includes(name) && !slash) return null;
  return TAKES_NO_ARGUMENTS.includes(name) && args ? null : { name, args };
}

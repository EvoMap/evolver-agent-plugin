// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// A Codex plugin cannot add slash commands, so a command is typed into the prompt box as it is (a leading `/` is
// accepted) and the prompt hook answers it. Only a prompt that is exactly a command counts, so a prompt that merely
// starts with a command's name stays a prompt, and one with text after a command that takes none (it has no hint).

import { commandCatalog, parsePromptCommand } from '../../lib/agent/commands.js';

export const COMMAND_NAMES = Object.freeze(commandCatalog.map((command) => command.name));
export const TAKES_NO_ARGUMENTS = Object.freeze(commandCatalog.filter((command) => !command.hint).map((command) => command.name));

export function promptCommandOf(prompt) {
  return parsePromptCommand(prompt);
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { COMMANDS, HOST_COMMANDS } from '../app/commands/index.js';

/** What a host may show of the plugin's commands: name, description, input hint, and whether it is a prompt for the agent. */
const catalogOf = (commands) => Object.freeze(commands.map(({ name, description, hint, forAgent }) =>
  Object.freeze({ name, description, hint, forAgent: Boolean(forAgent) })));
export const commandCatalog = catalogOf(COMMANDS);
export const hostCommandCatalog = catalogOf(HOST_COMMANDS);

const PROMPT_COMMAND = /^(\/?)(?:([\w-]+):)?(evolver-[a-z]+)(?:\s+([\s\S]*))?$/;

export function parsePromptCommand(prompt, { catalog = commandCatalog, namespace, requireSlash = false, slashForAgent = false, ignoreExtra = false } = {}) {
  const match = PROMPT_COMMAND.exec(String(prompt ?? '').trim());
  if (!match) return null;
  const [, slash, prefix, name, rawArgs = ''] = match;
  const command = catalog.find((entry) => entry.name === name);
  if (!command || (!slash && (requireSlash || (slashForAgent && command.forAgent)))) return null;
  if (prefix && namespace !== true && namespace !== prefix) return null;
  const args = rawArgs.trim();
  if (args && !command.hint) return ignoreExtra ? { name, args: '' } : null;
  return { name, args };
}

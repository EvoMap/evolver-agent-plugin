// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import distill from './distill.js';
import drafts from './drafts.js';
import evolve from './evolve.js';
import evolverCli from './evolver-cli.js';
import { failure } from './result.js';
import search from './search.js';
import status from './status.js';

// Every command is run by the plugin, not the model, whichever way the host lets a person type it.
export const COMMANDS = Object.freeze([status, search, distill, drafts, evolve, ...evolverCli]);

const TYPED_COMMAND = /^\/((?:[\w-]+:)?evolver-[\w-]+)(?:[ \t]+([\s\S]*))?$/;

/** The `/evolver-…` command a prompt is, with its raw argument text, or null; a plugin namespace before it is dropped. */
export function typedCommandOf(prompt) {
  const match = TYPED_COMMAND.exec(String(prompt ?? '').trim());
  if (!match) return null;
  return { name: match[1].replace(/^[\w-]+:/, ''), args: (match[2] ?? '').trim() };
}

export const commandNamed = (name) => COMMANDS.find((command) => command.name === name) ?? null;

/** `{ ok, text }`, plus `forAgent` for a prompt meant for the agent and `agentGene` for a Gene the agent may write. */
export async function runCommand(ports, { sessionId, projectDir = null, anySession = false, signal, name, args = '' }) {
  const command = commandNamed(name);
  if (!command) return failure(`Unknown command /${name}.`);
  try {
    return await command.run(ports, { sessionId, projectDir, anySession, signal, args });
  } catch (error) {
    return failure(`/${name} failed: ${String(error?.message ?? error)}`);
  }
}

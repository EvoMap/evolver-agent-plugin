// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nodeExecutable } from './process/node.js';
import { runProcess } from './process/spawn.js';
import { executableOf } from './process/which.js';

const ERROR_MAX_CHARS = 300;
const PREFLIGHT_TIMEOUT_MS = 10_000;

/**
 * The ModelRunner an agent's model declaration asks for:
 *   { kind: 'cli', command: (env) → path | null, or { names, dirs?(env), accepts?, nodeScriptOnWindows? } to look
 *     for (see process/which.js), args(model, prompt, { workdir, preflight }) → string[],
 *     parse({ stdout, stderr }) → { answer, usage }, input?(prompt) → stdin text ('' when the prompt is an argument),
 *     workdir?: 'empty' (a fresh folder, removed after), shim?,
 *     preflight?: { args, parse({ code, stdout }) → what `args` gets as `preflight`, or null not to run the model } }
 *   { kind: 'sdk', complete? }   an in-process host API; without `complete` here, the host's entry passes the model
 *                                 port itself when it builds the channel
 *   { kind: 'in-session' } | null                                no model outside the conversation
 * A cli run gets the prompt on stdin and the headless marker, and is killed with its tree on timeout or cancel.
 */
export function modelRunnerOf(declaration, env = process.env) {
  if (declaration?.kind === 'sdk') return typeof declaration.complete === 'function' ? { complete: declaration.complete } : null;
  if (declaration?.kind !== 'cli') return null;
  const found = typeof declaration.command === 'function'
    ? (declaration.command(env) ? { file: declaration.command(env), viaNode: false } : null)
    : executableOf({ ...declaration.command, dirs: declaration.command.dirs?.(env) ?? [] }, { env });
  if (!found) return null;
  const command = found.viaNode ? nodeExecutable() : found.file;
  const leading = found.viaNode ? [found.file] : [];
  const shim = declaration.shim && !found.viaNode;
  const preflightOf = async (signal) => {
    if (!declaration.preflight) return undefined;
    const ran = await runProcess(command, [...leading, ...declaration.preflight.args], { env, signal, shim, headless: true, timeoutMs: PREFLIGHT_TIMEOUT_MS });
    const checked = ran.error ? null : declaration.preflight.parse({ code: ran.code, stdout: ran.stdout });
    if (checked === null) throw new Error(`${command} ${declaration.preflight.args.join(' ')} gave no safe way to run the model`);
    return checked;
  };
  return {
    complete: async (model, prompt, signal) => {
      const preflight = await preflightOf(signal);
      const workdir = declaration.workdir === 'empty' ? mkdtempSync(join(tmpdir(), 'evolver-model-')) : undefined;
      try {
        const input = declaration.input ? declaration.input(prompt) : prompt;
        const args = [...leading, ...declaration.args(model, prompt, { workdir, preflight })];
        const result = await runProcess(command, args, { input, cwd: workdir, env, signal, shim, headless: true });
        if (result.error) throw result.error;
        if (result.code !== 0) throw new Error(`${command} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-ERROR_MAX_CHARS)}`);
        return declaration.parse(result);
      } finally {
        if (workdir) rmSync(workdir, { recursive: true, force: true });
      }
    },
  };
}

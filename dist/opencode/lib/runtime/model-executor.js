// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nodeExecutable } from './process/node.js';
import { runProcess } from './process/spawn.js';
import { executableOf } from './process/which.js';
import { markHeadlessWorkdir } from './headless.js';

const ERROR_MAX_CHARS = 300;
const PREFLIGHT_TIMEOUT_MS = 10_000;
const CONFIG_MAX_BYTES = 1024 * 1024;

function prepareConfig(declaration, env, workdir) {
  if (!declaration.configFile) return undefined;
  const source = declaration.configFile.source(env);
  const stat = statSync(source);
  if (!stat.isFile() || stat.size > CONFIG_MAX_BYTES) throw new Error('Model configuration must be a regular file of at most 1 MiB');
  const content = declaration.configFile.prepare(readFileSync(source, 'utf8'));
  const target = join(workdir, 'config.yaml');
  writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
  return target;
}

/** Why a run that exited non-zero failed: what its own output says when the declaration can read it, else its exit. */
function exitFailureOf(declaration, command, result) {
  try {
    declaration.parse(result);
  } catch (error) {
    return error;
  }
  return new Error(`${command} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-ERROR_MAX_CHARS)}`);
}

/**
 * The ModelRunner an agent's model declaration asks for:
 *   { kind: 'cli', command: (env) → path | null, or { names, dirs?(env), accepts?, nodeScriptOnWindows? } to look
 *     for (see process/which.js), args(model, prompt, { workdir, preflight }) → string[],
 *     parse({ stdout, stderr }) → { answer, usage }, input?(prompt) → stdin text ('' when the prompt is an argument),
 *     workdir?: 'empty' (a fresh folder, removed after), promptFile?: a file name in that folder the prompt is written
 *     to, handed to `args` as `promptPath`, env?: variables or (env) → variables for the run, shim?,
 *     configFile?: { source(env) → path, prepare(text) → text }, copied privately into the scratch folder and
 *     handed to `args` as `configPath`; the source file is never modified,
 *     preflight?: { args, parse({ code, stdout }) → what `args` gets as `preflight`, or null not to run the model } }
 *   { kind: 'sdk', complete? }   an in-process host API; without `complete` here, the host's entry passes the model
 *                                 port itself when it builds the channel
 *   { kind: 'in-session' } | null                                no model outside the conversation
 * A cli run gets the prompt on stdin (or in its prompt file) and the headless marker, and is killed with its tree on
 * timeout or cancel.
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
  const shim = (declaration.shim || /\.cmd$/i.test(found.file)) && !found.viaNode;
  const preflightOf = async (signal, runEnv) => {
    if (!declaration.preflight) return undefined;
    const ran = await runProcess(command, [...leading, ...declaration.preflight.args], { env: runEnv, signal, shim, headless: true, timeoutMs: PREFLIGHT_TIMEOUT_MS });
    const checked = ran.error ? null : declaration.preflight.parse({ code: ran.code, stdout: ran.stdout });
    if (checked === null) throw new Error(`${command} ${declaration.preflight.args.join(' ')} gave no safe way to run the model`);
    return checked;
  };
  return {
    complete: async (model, prompt, signal) => {
      const runEnv = declaration.env ? { ...env, ...(typeof declaration.env === 'function' ? declaration.env(env) : declaration.env) } : env;
      const preflight = await preflightOf(signal, runEnv);
      const workdir = declaration.workdir === 'empty' || declaration.promptFile || declaration.configFile ? mkdtempSync(join(tmpdir(), 'evolver-model-')) : undefined;
      try {
        if (workdir) markHeadlessWorkdir(workdir);
        const configPath = prepareConfig(declaration, runEnv, workdir);
        const promptPath = declaration.promptFile ? join(workdir, declaration.promptFile) : undefined;
        if (promptPath) writeFileSync(promptPath, prompt);
        const input = promptPath ? '' : declaration.input ? declaration.input(prompt) : prompt;
        const args = [...leading, ...declaration.args(model, prompt, { workdir, preflight, promptPath, configPath })];
        const result = await runProcess(command, args, { input, cwd: workdir, env: runEnv, signal, shim, headless: true });
        if (result.error) throw result.error;
        if (result.code !== 0) throw exitFailureOf(declaration, command, result);
        return declaration.parse(result);
      } finally {
        if (workdir) rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  };
}

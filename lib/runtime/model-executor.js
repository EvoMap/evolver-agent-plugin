// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { nodeExecutable } from './process/node.js';
import { runProcess } from './process/spawn.js';
import { executableOf } from './process/which.js';
import { markHeadlessWorkdir } from './headless.js';

const ERROR_MAX_CHARS = 300;
const PREFLIGHT_TIMEOUT_MS = 10_000;
const CONFIG_MAX_BYTES = 1024 * 1024;

function readConfigFile(source, bind) {
  const stat = (bind ? lstatSync : statSync)(source, { bigint: true });
  if (!stat.isFile() || stat.size > CONFIG_MAX_BYTES) throw new Error('Model configuration must be a regular file of at most 1 MiB');
  const text = readFileSync(source, 'utf8');
  if (!bind) return { text };
  const identityOf = ({ dev, ino, size, mtimeNs, ctimeNs }) => [dev, ino, size, mtimeNs, ctimeNs].join(':');
  const identity = identityOf(stat);
  if (identity !== identityOf(lstatSync(source, { bigint: true }))) throw modelUnavailable('route_changed');
  const changedAt = Number(stat.mtimeMs > stat.ctimeMs ? stat.mtimeMs : stat.ctimeMs);
  return { text, changedAt, identity };
}

function readConfig(declaration, env) {
  const { bind, source } = declaration.configFile;
  const paths = source(env);
  if (!bind) return readConfigFile(paths, false);
  const snapshots = [paths].flat().map((file) => readConfigFile(file, true));
  const texts = snapshots.map(({ text }) => text);
  const digest = createHash('sha256').update(JSON.stringify(texts)).digest('hex');
  const changedAt = Math.max(...snapshots.map(({ changedAt }) => changedAt));
  return { text: Array.isArray(paths) ? texts : texts[0], digest, changedAt, stamp: `${snapshots.map(({ identity }) => identity).join(':')}:${digest}` };
}

function modelUnavailable(reason) {
  return Object.assign(new Error('The captured model configuration is unavailable'), { code: 'MODEL_UNAVAILABLE', reason });
}

function writePrivateFiles(workdir, files) {
  for (const [relative, text] of Object.entries(files ?? {})) {
    const file = resolve(workdir, relative);
    if (isAbsolute(relative) || !file.startsWith(`${workdir}${sep}`)) throw new Error('Private model files must stay within their work directory');
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
  }
}

function prepareConfig(declaration, env, workdir, model) {
  if (!declaration.configFile) return undefined;
  const { bind, prepare } = declaration.configFile;
  if (bind && !model?.configDigest) throw modelUnavailable(model?.unavailable ?? 'route_unresolved');
  let config;
  try { config = readConfig(declaration, env); }
  catch (error) { if (bind && error.code !== 'MODEL_UNAVAILABLE') throw modelUnavailable('credential_missing'); throw error; }
  if (bind && model.configDigest !== config.digest) throw modelUnavailable('route_changed');
  const prepared = prepare(config.text, model);
  const { content, files } = typeof prepared === 'string' ? { content: prepared } : prepared;
  const target = join(workdir, 'config.yaml');
  writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
  writePrivateFiles(workdir, files);
  return target;
}

/** Why a run that exited non-zero failed: what its own output says when the declaration can read it, else its exit. */
function exitFailureOf(declaration, command, result, model) {
  try {
    declaration.parse(result, model);
  } catch (error) {
    return error;
  }
  return new Error(`${command} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-ERROR_MAX_CHARS)}`);
}

/**
 * The ModelRunner an agent's model declaration asks for:
 *   { kind: 'cli', command: (env) → path | null, or { names, dirs?(env), accepts?, nodeScriptOnWindows? } to look
 *     for (see process/which.js), args(model, prompt, { workdir, preflight }) → string[],
 *     parse({ stdout, stderr }, model) → { answer, usage }, input?(prompt, model, { workdir }) → stdin text,
 *     closeInputOn?(line) keeps stdin open until a one-shot protocol responds,
 *     workdir?: 'empty' (a fresh folder, removed after), promptFile?: a file name in that folder the prompt is written
 *     to, handed to `args` as `promptPath`, workdirFiles?: private static scratch-relative files,
 *     env?: variables or (env, { workdir, configPath }) → variables for the run, isolated?: omit inherited env,
 *     shim?, timeoutMs?, configFile?: { source(env) → path, prepare(text, model) → text, bind?, settleMs? },
 *     copied privately into the scratch folder and
 *     handed to `args` as `configPath`; the source file is never modified,
 *     bound configurations may read several paths and return { content, files } for private companion files,
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
  const capture = declaration.configFile?.bind === true;
  if (!found && !capture) return null;
  const configStamp = () => {
    try {
      const config = readConfig(declaration, env);
      return Date.now() - config.changedAt >= (declaration.configFile.settleMs ?? 0) ? config.stamp : null;
    } catch { return null; }
  };
  if (!found) return {
    capture, configStamp,
    complete: async () => { throw modelUnavailable('unsafe_runtime'); },
  };
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
    ...(capture && { capture, configStamp }),
    complete: async (model, prompt, stopping) => {
      const deadline = declaration.timeoutMs ? AbortSignal.timeout(declaration.timeoutMs) : null;
      const signal = stopping && deadline ? AbortSignal.any([stopping, deadline]) : stopping ?? deadline;
      signal?.throwIfAborted();
      const workdir = declaration.workdir === 'empty' || declaration.promptFile || declaration.configFile || declaration.workdirFiles
        ? mkdtempSync(join(tmpdir(), 'evolver-model-')) : undefined;
      try {
        if (workdir) markHeadlessWorkdir(workdir);
        writePrivateFiles(workdir, declaration.workdirFiles);
        const configPath = declaration.configFile ? join(workdir, 'config.yaml') : undefined;
        if (capture) prepareConfig(declaration, env, workdir, model);
        const overrides = typeof declaration.env === 'function' ? declaration.env(env, { workdir, configPath }) : declaration.env;
        const runEnv = declaration.isolated ? (overrides ?? {}) : { ...env, ...overrides };
        const preflight = await preflightOf(signal, runEnv);
        const prepared = capture ? configPath : prepareConfig(declaration, runEnv, workdir, model);
        const promptPath = declaration.promptFile ? join(workdir, declaration.promptFile) : undefined;
        if (promptPath) writeFileSync(promptPath, prompt);
        const input = promptPath ? '' : declaration.input ? declaration.input(prompt, model, { workdir }) : prompt;
        const args = [...leading, ...declaration.args(model, prompt, { workdir, preflight, promptPath, configPath: prepared })];
        const result = await runProcess(command, args, {
          input, closeInputOn: declaration.closeInputOn, cwd: workdir, env: runEnv, signal, shim, headless: true,
        });
        signal?.throwIfAborted();
        if (result.error) throw result.error;
        if (result.code !== 0) throw exitFailureOf(declaration, command, result, model);
        return declaration.parse(result, model);
      } finally {
        if (workdir) rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
  };
}

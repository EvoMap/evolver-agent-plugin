// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const MODEL_ID = /^[\w.:@/-]+$/;
const UNNAMED_MODELS = new Set(['default', 'auto', 'unknown']);
const ERROR_MAX_CHARS = 300;

/** The chat's model as Cursor names it in a hook payload; an empty name is the chat on Cursor's default. */
export const sessionModelOf = (payload) => ({ model: typeof payload.model === 'string' && payload.model ? payload.model : 'default' });

/**
 * One read-only answer, not an agent run: print mode in ask mode, without --force so nothing is applied, on the
 * chat's model when Cursor named one, the prompt as the argument the docs name. --trust trusts the workspace, so it is
 * the run's own empty folder: no project files, rules or hooks come along.
 */
export function cursorAgentArguments(model, prompt, { workdir }) {
  const name = model?.model;
  const named = MODEL_ID.test(name ?? '') && !UNNAMED_MODELS.has(name) ? ['--model', name] : [];
  return ['-p', '--output-format', 'json', '--mode', 'ask', '--trust', '--workspace', workdir, ...named, prompt];
}

const CLI_NAME = 'cursor-agent';

/** Where the Cursor CLI is looked for: `cursor-agent`, else an `agent` (its installer's generic name) that is it. */
export const cursorAgentCommand = Object.freeze({
  names: [CLI_NAME, 'agent'],
  dirs: (env) => (env.HOME ? [`${env.HOME}/.local/bin`] : []),
  accepts: (name, realPath) => name === CLI_NAME || realPath.includes(CLI_NAME),
});

function parsedJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** The answer of one `--output-format json` run, which prints a single `result` object and no token usage. */
export function completionOf({ stdout, stderr }) {
  const result = parsedJson(String(stdout ?? '').trim());
  if (!result || result.is_error || typeof result.result !== 'string') {
    const detail = `${stderr ?? ''}${stdout ?? ''}`.trim().slice(-ERROR_MAX_CHARS) || 'empty output';
    throw new Error(`cursor-agent gave no answer: ${detail}`);
  }
  return { answer: result.result, usage: null };
}

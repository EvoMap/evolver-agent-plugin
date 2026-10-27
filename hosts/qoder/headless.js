// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The distillation is one answer from Qoder CLI in print mode, on the person's own sign-in and default model: no
// built-in tools, no MCP servers, no hooks (they would start this plugin again), one turn, nothing saved, the prompt on
// stdin in an empty folder.

const HEADLESS_ARGS = Object.freeze([
  '-p', '--output-format', 'json',
  '--tools', '',
  '--strict-mcp-config',
  '--settings', JSON.stringify({ disableAllHooks: true }),
  '--max-turns', '1',
  '--no-session-persistence',
]);
const ERROR_MAX_CHARS = 300;

function parsedJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function usageOf(usage) {
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;
  return Number.isFinite(inputTokens) && Number.isFinite(outputTokens) ? { inputTokens, outputTokens } : null;
}

/** The answer and usage of one `--output-format json` run, a single `result` object; an error result throws. */
export function completionOf({ stdout, stderr }) {
  const result = parsedJson(String(stdout ?? '').trim());
  if (!result || result.is_error || typeof result.result !== 'string') {
    const detail = typeof result?.result === 'string' ? result.result : `${stdout ?? ''}${stderr ?? ''}`;
    throw new Error(`qodercli gave no answer: ${String(detail).trim().slice(0, ERROR_MAX_CHARS) || 'empty output'}`);
  }
  return { answer: result.result, usage: usageOf(result.usage) };
}

// Off the PATH, the CLI's installer puts it in ~/.local/bin or under ~/.qoder/bin; npm on Windows installs a .cmd
// shim, which the prompt on stdin lets cmd.exe run.
const installDirs = (env) => {
  const home = env.HOME || env.USERPROFILE || '';
  return home ? [`${home}/.local/bin`, `${home}/.qoder/bin/qodercli`] : [];
};

export const headlessQodercli = Object.freeze({
  kind: 'cli',
  command: Object.freeze({ names: ['qodercli'], dirs: installDirs, windowsShims: true }),
  args: () => [...HEADLESS_ARGS],
  parse: completionOf,
  workdir: 'empty',
});

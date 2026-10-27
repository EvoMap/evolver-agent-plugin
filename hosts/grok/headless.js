// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The distillation is one answer from grok itself, not an agent run: print mode on the person's own config, in an
// empty folder, with the prompt on stdin, no tools, subagents, plan mode or web search, and one model call at most.

const MODEL_ID = /^[\w.:@/-]+$/;
const ERROR_MAX_CHARS = 300;
const COMPLETED = 'end_turn';

// `--tools` takes effect only when it names a real tool; `--disallowed-tools` then removes that one and the MCP
// meta-tools `--tools` always keeps, so the model is offered none.
const NO_TOOLS = Object.freeze(['--tools', 'todo_write', '--disallowed-tools', 'todo_write,search_tool,use_tool']);

export function grokPrintArguments(model, prompt, { workdir }) {
  const named = MODEL_ID.test(model?.model ?? '') ? ['-m', model.model] : [];
  return [
    '-p', '-', '--output-format', 'json', '--verbatim', '--cwd', workdir,
    '--no-auto-update', '--no-subagents', '--no-plan', '--disable-web-search', '--max-turns', '1',
    ...NO_TOOLS,
    ...named,
  ];
}

/** Where grok is looked for: on the PATH, else in the folder its installer writes. */
export const grokCommand = Object.freeze({
  names: ['grok'],
  dirs: (env) => {
    const home = env.HOME || env.USERPROFILE;
    return home ? [`${home}/.grok/bin`] : [];
  },
});

function parsedJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function usageOf(usage) {
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cache_read_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_tokens,
  };
}

/** The answer of one `--output-format json` run: a result object, or an error object in its place. */
export function completionOf({ stdout, stderr }) {
  const result = parsedJson(String(stdout ?? '').trim());
  if (!result || result.type === 'error' || result.stopReason !== COMPLETED || typeof result.text !== 'string') {
    const detail = result?.message ?? result?.stopReason ?? `${stderr ?? ''}${stdout ?? ''}`.trim();
    throw new Error(`grok gave no answer: ${String(detail || 'empty output').slice(-ERROR_MAX_CHARS)}`);
  }
  return { answer: result.text, usage: usageOf(result.usage) };
}

export const headlessGrok = Object.freeze({
  kind: 'cli',
  command: grokCommand,
  args: grokPrintArguments,
  parse: completionOf,
  workdir: 'empty',
});

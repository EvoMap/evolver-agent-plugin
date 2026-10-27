// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The distillation is one answer from grok itself, not an agent run: print mode on the person's own config, in an
// empty folder, the prompt from a file there, no tools, subagents, plan mode or web search. grok runs the hooks it
// finds even in print mode, and a blocking Stop hook there keeps the turn going past --max-turns; the Claude Code
// and Cursor hook files it imports are turned off for the run, with their rules, skills and MCP servers. Hooks in
// ~/.grok and other plugins' hooks have no switch, so an answer that took more than one model turn is refused.

const MODEL_ID = /^[\w.:@/-]+$/;
const ERROR_MAX_CHARS = 300;
const COMPLETED = 'end_turn';
const PROMPT_FILE = 'prompt.md';

// `--tools` takes effect only when it names a real tool; `--disallowed-tools` then removes that one and the MCP
// meta-tools `--tools` always keeps, so the model is offered none.
const NO_TOOLS = Object.freeze(['--tools', 'todo_write', '--disallowed-tools', 'todo_write,search_tool,use_tool']);

const COMPAT_SURFACES = ['HOOKS', 'MCPS', 'RULES', 'SKILLS', 'AGENTS'];
export const ISOLATED_ENV = Object.freeze({
  ...Object.fromEntries(['CLAUDE', 'CURSOR'].flatMap((vendor) => COMPAT_SURFACES.map((surface) => [`GROK_${vendor}_${surface}_ENABLED`, 'false']))),
  GROK_TURN_SUMMARY: 'false',
  GROK_MEMORY: '0',
});

export function grokPrintArguments(model, prompt, { workdir, promptPath }) {
  const named = MODEL_ID.test(model?.model ?? '') ? ['-m', model.model] : [];
  return [
    '--prompt-file', promptPath, '--output-format', 'json', '--verbatim', '--cwd', workdir,
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

function refusalOf(result, { stdout, stderr }) {
  if (!result) return `${stderr ?? ''}${stdout ?? ''}`.trim() || 'empty output';
  if (result.type === 'error') return result.message;
  if (result.num_turns > 1) return `the run took ${result.num_turns} model turns (a Stop hook of yours keeps a turn going)`;
  return result.stopReason !== COMPLETED || typeof result.text !== 'string' ? result.stopReason ?? 'no text' : null;
}

/** The answer of one `--output-format json` run: a result object of one model turn, or an error object in its place. */
export function completionOf(output) {
  const result = parsedJson(String(output.stdout ?? '').trim());
  const refusal = refusalOf(result, output);
  if (refusal) throw new Error(`grok gave no answer: ${String(refusal).slice(-ERROR_MAX_CHARS)}`);
  return { answer: result.text, usage: usageOf(result.usage) };
}

export const headlessGrok = Object.freeze({
  kind: 'cli',
  command: grokCommand,
  args: grokPrintArguments,
  parse: completionOf,
  workdir: 'empty',
  promptFile: PROMPT_FILE,
  env: ISOLATED_ENV,
});

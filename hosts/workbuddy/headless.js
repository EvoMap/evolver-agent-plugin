// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// Hooks have no model API, so a distillation runs the CodeBuddy CLI headless on the turn's model, with no tools
// and one turn, the prompt on stdin.

const HEADLESS_ARGS = ['-p', '--tools', '', '--no-session-persistence', '--output-format', 'json', '--max-turns', '1'];
const MODEL_ID = /^[\w.:@/-]+$/;
const ERROR_MAX_CHARS = 300;

function parsedJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function usageOf(usage) {
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;
  return Number.isFinite(inputTokens) && Number.isFinite(outputTokens) ? { inputTokens, outputTokens } : null;
}

/**
 * The answer and token usage of one `--output-format json` run. The CLI prints a single `result` object (an array
 * of events under --verbose); an error, or plain text such as "Authentication required", throws.
 */
export function completionOf({ stdout, stderr }) {
  const parsed = parsedJson(String(stdout ?? '').trim());
  const result = Array.isArray(parsed) ? parsed.findLast((event) => event?.type === 'result') : parsed;
  if (!result || result.is_error || typeof result.result !== 'string') {
    const detail = Array.isArray(result?.errors) ? result.errors.join('; ') : `${stdout ?? ''}${stderr ?? ''}`;
    throw new Error(`codebuddy gave no answer: ${String(detail).trim().slice(0, ERROR_MAX_CHARS) || 'empty output'}`);
  }
  return { answer: result.result, usage: usageOf(result.usage) };
}

const modelArgs = (model) => (MODEL_ID.test(model?.model ?? '') ? ['--model', model.model] : []);

export const headlessCodebuddy = Object.freeze({
  kind: 'cli',
  command: () => 'codebuddy',
  args: (model) => [...HEADLESS_ARGS, ...modelArgs(model)],
  parse: completionOf,
  shim: true,
});

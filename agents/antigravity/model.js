// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The distillation is one answer from Antigravity itself, headless. `agy` has no flag that turns hooks, plugins or
// tools off and none that reads a plain prompt from stdin, so the prompt goes in as one stream-json `user` event,
// in an empty workspace where headless mode denies the shell, and no prompt is read as a slash command or skill.

const STREAM_JSON = Object.freeze(['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands']);
const ERROR_MAX_CHARS = 300;

function resultOf(stdout) {
  let result = null;
  for (const line of String(stdout).split('\n')) {
    try {
      const event = line.trim() ? JSON.parse(line) : null;
      if (event?.event === 'result') result = event.result;
    } catch {
    }
  }
  return result;
}

function usageOf(usage) {
  if (!usage) return null;
  return { inputTokens: usage.input_tokens, cachedInputTokens: usage.cache_read_tokens, outputTokens: usage.output_tokens, reasoningOutputTokens: usage.thinking_tokens };
}

/** The run's `result` event as `{ answer, usage }`; any status but SUCCESS throws with the reason agy gave. */
function answerOf({ stdout, stderr }) {
  const result = resultOf(stdout);
  if (result?.status === 'SUCCESS') return { answer: String(result.response ?? ''), usage: usageOf(result.usage) };
  const reason = result?.error || String(stderr ?? '').trim() || 'no result';
  throw new Error(`agy ${result?.status ?? 'failed'}: ${String(reason).slice(-ERROR_MAX_CHARS)}`);
}

/** `model` is what the turn's hooks named, `{ model: modelName }`, the shape candidates are stored with. */
// TODO: lib/runtime/model-executor.js honours neither `input` nor `workdir` yet; until it does, agy gets the raw
// prompt on stdin, rejects it as invalid stream-json and the candidate's tries run out.
export const agyModel = Object.freeze({
  kind: 'cli',
  command: () => 'agy',
  args: ({ model }) => [...STREAM_JSON, '--model', model],
  input: (prompt) => `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`,
  workdir: 'empty',
  parse: answerOf,
});

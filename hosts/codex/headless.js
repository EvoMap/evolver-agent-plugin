// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The distillation is one answer from Codex itself, not an agent run: no hooks (they would start this plugin
// again), no plugins, apps, shell, subagents or web search, a read-only sandbox in an empty folder, nothing saved,
// the prompt on stdin and the answer read off the `--json` events.
//
// --ignore-user-config keeps the MCP servers of the person's config.toml from starting outside that sandbox
// (`--disable plugins` leaves them on, and an override cannot empty the table). It drops their model provider too:
// the standalone plugin listed the servers first and turned each off by name, which a model declaration cannot.

const DISABLED_FEATURES = Object.freeze(['hooks', 'plugins', 'shell_tool', 'apps', 'multi_agent']);
const MODEL_ID = /^[\w.:@/-]+$/;
const ERROR_MAX_CHARS = 300;

function codexExecArguments(model, prompt, { workdir }) {
  const named = MODEL_ID.test(model?.model ?? '') ? ['-m', model.model] : [];
  return [
    'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '--ignore-user-config', '--json',
    '--sandbox', 'read-only',
    ...DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
    '-c', 'web_search="disabled"',
    ...named,
    '-C', workdir,
    '-',
  ];
}

function eventsOf(stdout) {
  return String(stdout ?? '').split('\n').flatMap((line) => {
    try {
      const event = line.trim() ? JSON.parse(line) : null;
      return event && typeof event === 'object' ? [event] : [];
    } catch {
      return [];
    }
  });
}

function usageOf(usage) {
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
  };
}

function failureOf(event) {
  if (event.type === 'turn.failed') return event.error?.message;
  return event.type === 'error' ? event.message : null;
}

/** The last agent message of one `codex exec --json` run and the turn's usage; a run that answered none throws. */
function completionOf({ stdout, stderr }) {
  const events = eventsOf(stdout);
  const answer = events.findLast((event) => event.type === 'item.completed' && event.item?.type === 'agent_message');
  if (!answer) {
    const detail = events.map(failureOf).findLast(Boolean) || String(stderr ?? '').trim() || 'no agent message';
    throw new Error(`codex exec gave no answer: ${String(detail).slice(-ERROR_MAX_CHARS)}`);
  }
  const usage = events.findLast((event) => event.type === 'turn.completed')?.usage;
  return { answer: String(answer.item.text ?? ''), usage: usageOf(usage) };
}

export const headlessCodex = Object.freeze({
  kind: 'cli',
  command: Object.freeze({ names: ['codex'] }),
  args: codexExecArguments,
  parse: completionOf,
  workdir: 'empty',
});

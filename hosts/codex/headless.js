// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The distillation is one answer from Codex itself, not an agent run: no hooks (they would start this plugin
// again), no plugins, apps, shell, subagents or web search, a read-only sandbox in an empty folder, nothing saved,
// the prompt on stdin and the answer read off the `--json` events. It runs on the person's own config.toml, so on
// the model provider their session used; `--disable plugins` leaves that config's MCP servers on, which would run
// outside the sandbox, so they are listed first and each turned off by name, and the model is not run at all when
// they cannot be listed.

const DISABLED_FEATURES = Object.freeze(['hooks', 'plugins', 'shell_tool', 'apps', 'multi_agent']);
const DISABLED_FEATURE_FLAGS = Object.freeze(DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]));
const MODEL_ID = /^[\w.:@/-]+$/;
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const ERROR_MAX_CHARS = 300;

/** The enabled MCP servers `codex mcp list --json` names, or null when it cannot be read or names one no override can address. */
export function enabledMcpServersOf({ code, stdout }) {
  if (code !== 0) return null;
  try {
    const servers = JSON.parse(stdout);
    if (!Array.isArray(servers)) return null;
    const enabled = servers.filter((server) => server?.enabled === true).map((server) => String(server.name));
    return enabled.every((name) => MCP_SERVER_NAME.test(name)) ? enabled : null;
  } catch {
    return null;
  }
}

function codexExecArguments(model, prompt, { workdir, preflight: mcpServers = [] }) {
  const named = MODEL_ID.test(model?.model ?? '') ? ['-m', model.model] : [];
  return [
    'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-rules', '--json',
    '--sandbox', 'read-only',
    ...DISABLED_FEATURE_FLAGS,
    '-c', 'web_search="disabled"',
    ...mcpServers.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]),
    ...named,
    '-C', workdir,
    '-',
  ];
}

// Codex Desktop ships its CLI inside the app, off the PATH; an npm install on Windows is a `codex.cmd` shim, which the
// prompt on stdin lets cmd.exe run.
function desktopDirs(env) {
  const home = env.HOME || env.USERPROFILE || '';
  return [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin',
    `${home}/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin`,
    ...(env.LOCALAPPDATA ? [`${env.LOCALAPPDATA}/Programs/ChatGPT/resources/codex-cli/bin`] : []),
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
  command: Object.freeze({ names: ['codex'], dirs: desktopDirs, windowsShims: true }),
  preflight: Object.freeze({ args: [...DISABLED_FEATURE_FLAGS, 'mcp', 'list', '--json'], parse: enabledMcpServersOf }),
  args: codexExecArguments,
  parse: completionOf,
  workdir: 'empty',
});

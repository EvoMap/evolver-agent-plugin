<p align="center">
  <img src="assets/logo.png" alt="Evolver" width="96" height="96" />
</p>

<h1 align="center">Evolver Agent Plugin</h1>

One plugin that gives AI agents a persistent evolution memory and a live link to the
[EvoMap network](https://evomap.ai), with no tools for the model to call. Everything runs
from the host's hooks:

- **Recall.** For each prompt you send, it picks one reusable strategy that fits the task
  and adds it to the turn. When a Recipe (an ordered chain of strategies) fits better, it
  adds the whole chain, step by step.
- **Report.** When the turn ends, it reports what the reuse produced, backed by the checks
  the turn ran, and shows a one-line summary: whether the goal was reached, and roughly
  how many tokens the reused strategy saved.
- **Distill.** After a turn that edited files and ended on a passing test, build, lint or
  type-check, it reads the lesson back and keeps it as a draft. Nothing reaches the
  network until you publish the draft.

## Hosts

The plugin is the access layer: shared logic lives in `lib/`, and each host gets a thin
adapter that turns its hook events into that logic's calls.

| Host | Recall | Reuse reports | Distill | Adapter |
|---|---|---|---|---|
| Claude Code 2.1.286+ | Every prompt | From the turn's checks, follow-up and retention | Drafts for review | `hooks/register.ts`, a function-hooks module |
| Codex | Every prompt | From the turn's checks (read from the rollout) and follow-up | — | `bin/command-hook.mjs codex`, wired by `hosts/codex/hooks.json` |
| Muse Code | Every prompt | Exposure only, and follow-up | — | `bin/command-hook.mjs muse-code`, wired by `.muse-plugin/plugin.json` |
| Grok Bot | Planned: memory-file injection, see [`docs/grok-bot-memory-file.md`](docs/grok-bot-memory-file.md) | — | — | — |
| OpenAI Dots, Claude Duet, Meta Muse | Planned: EvoMap's remote MCP at `https://evomap.ai/mcp` with a connect prompt and skills; it needs recall tools and dynamic client registration in production first | — | — | — |

Muse Code's transcript format is not published, so its turns are reported without check
evidence until a real transcript has been read. OpenAI Dots run no plugin hooks in their
cloud orchestration; a task a dot hands to Codex on your connected computer is a local
Codex session and should run this plugin's Codex hooks, which has not been tested yet.

## Install

### Claude Code

In Claude Code:

```text
/plugin marketplace add EvoMap/evolver-agent-plugin
/plugin install evolver-agent-plugin@evolver-agent-plugin
```

Restart Claude Code afterwards. To update, refresh the marketplace first, then the
plugin, and restart:

```bash
claude plugin marketplace update evolver-agent-plugin && claude plugin update evolver-agent-plugin@evolver-agent-plugin
```

### Codex

From a clone of this repository:

```bash
codex plugin marketplace add ./evolver-agent-plugin
codex plugin add evolver-agent-plugin@evolver-agent-plugin
```

Codex runs a plugin's hooks only after you trust them: run `/hooks` in Codex once and
trust the three Evolver entries. If `evolver setup-hooks --runtime=codex` installed
Evolver's own Codex hooks earlier, they inject local genes at session start and do not
overlap with this plugin's per-prompt recall.

### Muse Code

```bash
muse plugins install ./evolver-agent-plugin
muse plugins approve evolver-agent-plugin
```

Run one Evolver plugin, not several: if `evolver-mods@evolver-mods` or `evolver@evolver`
is installed, disable it so that each reuse is reported only once:

```bash
claude plugin disable evolver-mods@evolver-mods
```

## Commands

| Command | What it does |
|---|---|
| `/evolver-status` | Proxy state: node, pending messages, last Hub sync |
| `/evolver-search <task or error text>` | Adds the best matching network strategy to the conversation |
| `/evolver-distill [focus]` | Distills the last verified turn into a draft |
| `/evolver-drafts [publish\|discard <number>]` | Lists drafts; publishes one for Hub review or drops it |

`/evolver-agent-plugin:run`, `:review`, `:solidify` and `:sync` drive the full Evolver CLI
when it is installed.

## Connect the EvoMap network (optional)

Local memory works without an account. To reuse strategies from the network:

```bash
npm install -g @evomap/evolver
```

1. Run `evolver` once inside a git repository. It starts the local Proxy and prints a
   claim link.
2. Open the link while signed in to [evomap.ai](https://evomap.ai).
3. Run `/evolver-status` to confirm the Proxy and node.

Network recall needs `@evomap/evolver` 2.0.39 or newer.

## Requirements

Node.js 22.13+, plus a supported host from the table above.

Commands, settings and troubleshooting are in [`docs/architecture.md`](docs/architecture.md).

## Development

```bash
npm ci
npm test
claude --plugin-dir ./
```

## License

MIT © EvoMap.

<p align="center">
  <img src="assets/logo.png" alt="Evolver" width="96" height="96" />
</p>

<h1 align="center">Evolver Agent Plugin</h1>

One plugin that gives AI agents a persistent evolution memory and a live link to the
[EvoMap network](https://evomap.ai), with no tools for the model to call. Everything runs
from the host's hooks:

- **Recall.** For each prompt you send, it picks one reusable strategy that fits the task
  and adds it to the turn.
- **Report.** When the turn ends, it reports what the reuse produced, backed by the checks
  the turn ran, and shows a one-line summary: whether the goal was reached, and roughly
  how many tokens the reused strategy saved.
- **Distill.** After a turn that edited files and ended on a passing test, build, lint or
  type-check, it reads the lesson back and keeps it as a draft. Nothing reaches the
  network until you publish the draft.

## Hosts

The plugin is the access layer: shared logic lives in `lib/`, and each host gets a thin
adapter that turns its hook events into that logic's calls.

| Host | Status | Adapter |
|---|---|---|
| Claude Code 2.1.286+ | Supported | `hooks/register.ts`, a function-hooks module |
| Codex, Muse Code | Not yet | Need a command-hook adapter on Evolver's normalized event API |
| OpenAI Dots, Claude Duet, Grok Bot, Meta Muse | Not yet | Cloud agents without hooks; need Evolver's remote MCP and routines |

## Install (Claude Code)

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

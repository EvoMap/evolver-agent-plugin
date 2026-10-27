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
| WorkBuddy / CodeBuddy | Supported | `hosts/workbuddy`, command hooks; installs `dist/workbuddy` |
| Cursor | Supported | `hosts/cursor`, command hooks; installs the repo root |
| Antigravity | Supported | `hosts/antigravity`, command hooks; installs `dist/antigravity` |
| OpenCode 1.19.4+ | Supported | `hosts/opencode`, an in-process plugin; installs `dist/opencode` |
| Any MCP client without hooks (Kiro, openclaw, …) | Supported | `hosts/mcp-generic`, `node bin/mcp.mjs mcp-generic` over stdio |
| Codex, Muse Code | Not yet | Need a command-hook adapter on Evolver's normalized event API |
| OpenAI Dots, Claude Duet, Grok Bot, Meta Muse | Not yet | Cloud agents without hooks; need Evolver's remote MCP and routines |

Every host but Claude Code runs on one stack (`lib/channels`, `lib/agent`, `lib/app`, `lib/runtime`), described in
[`docs/architecture.md`](docs/architecture.md); `hosts/README.md` lists how each host differs.

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

## Install (other hosts)

WorkBuddy, Antigravity and OpenCode install a folder packed for them (`npm run pack`, into `dist/<host>`). CI packs
every tested push to `main` and commits the result to the `release` branch: `main` plus `dist/`.

- **WorkBuddy / CodeBuddy:** `/plugin marketplace add EvoMap/evolver-agent-plugin`, then
  `/plugin install evolver@evomap-workbuddy`; the marketplace installs `dist/workbuddy` from the `release` branch. It
  replaces the standalone plugin of that name and keeps its data folder. WorkBuddy updates an installed plugin only
  when its version changes, so a release meant to reach installs bumps the version in
  `hosts/workbuddy/dist/.codebuddy-plugin/` and in `.codebuddy-plugin/marketplace.json` together. To try a local
  build, `npm run pack` and add `<checkout>/dist/workbuddy` as the marketplace instead: the packed folder is a
  marketplace of its own.
- **Cursor:** add this repository as a plugin marketplace and install `evolver`; it installs the repo itself.
- **Antigravity:** from the `release` branch,
  `git clone --depth 1 --branch release https://github.com/EvoMap/evolver-agent-plugin.git`, then
  `agy plugin install evolver-agent-plugin/dist/antigravity`; it replaces `evolver-antigravity-plugin`.
  Its commands run from a terminal: `node <installed plugin>/bin/command.mjs antigravity evolver-status` (or
  `evolver-search <text>`, `evolver-distill`, `evolver-drafts publish 1`, …).
- **OpenCode:** `opencode plugin <release clone>/dist/opencode` (the folder is the `@evomap/evolver-opencode`
  package, not published to npm yet); remove the old `evolver-opencode-plugin` first, or every reuse is reported
  twice.
- **An MCP client without hooks:** in a checkout, `npm ci` (the server needs the MCP SDK), then register
  `node <checkout>/bin/mcp.mjs mcp-generic` as an stdio MCP server.

A host's first session adopts what its standalone plugin left (turn counters, open injections, undelivered reports),
so nothing is reported twice or lost on the way over.

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

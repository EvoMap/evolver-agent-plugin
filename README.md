<p align="center">
  <img src="assets/logo.png" alt="Evolver" width="96" height="96" />
</p>

<h1 align="center">evolver-plugin</h1>

`evolver-plugin` connects AI agents to Evolver: one plugin, the same on every agent, that gives
it a persistent evolution memory and a live link to the [EvoMap network](https://evomap.ai), with
no tools for the model to call. Evolver ships as two projects for now, which will merge into one:

- **`evolver`** (`@evomap/evolver`): the engine, with the local Proxy, the memory graph and the Hub
  link. The plugin installs it, starts its Proxy and keeps it at a supported version by itself.
- **`evolver-plugin`** (this repository, `EvoMap/evolver-agent-plugin`): every agent's adapter.

Everything runs from the host's hooks or plugin API:

- **Recall.** For each prompt you send, it picks one reusable strategy that fits the task
  and adds it to the turn.
- **Report.** When the turn ends, it reports what the reuse produced, backed by the checks
  the turn ran. Claude Code also shows a one-line summary: whether the goal was reached,
  and roughly how many tokens the reused strategy saved.
- **Distill.** After the session ends, its last turn that edited files and ended on a
  passing test, build, lint or type-check is distilled into a draft Gene. Nothing reaches
  the network until you publish the draft.

## Hosts

The plugin is the access layer: shared logic lives in `lib/`, and each host is a profile in
`hosts/<host>/` that says where it differs, plus what the host installs.

| Host | Status | Adapter |
|---|---|---|
| Claude Code 2.1.286+ | Supported | `hosts/claude-code`, a hooks module relaying to a Node process; installs `dist/claude-code` |
| WorkBuddy / CodeBuddy | Supported | `hosts/workbuddy`, command hooks; installs `dist/workbuddy` |
| Cursor | Supported | `hosts/cursor`, command hooks; installs the repo root |
| Antigravity | Supported | `hosts/antigravity`, command hooks; installs `dist/antigravity` |
| OpenCode 1.19.4+ | Supported | `hosts/opencode`, an in-process plugin; installs `dist/opencode` |
| Any MCP client without hooks (Kiro, openclaw, …) | Supported | `hosts/mcp-generic`, `node bin/mcp.mjs mcp-generic` over stdio |
| Codex | Supported | `hosts/codex`, command hooks; installs `dist/codex` |
| Muse Code | Not yet | No reviewed adapter yet |
| OpenAI Dots, Claude Duet, Grok Bot, Meta Muse | Not yet | Cloud agents without hooks; need Evolver's remote MCP and routines |

Every host runs on one stack (`lib/channels`, `lib/agent`, `lib/app`, `lib/runtime`), described in
[`docs/architecture.md`](docs/architecture.md); `hosts/README.md` lists how each host differs.

## Install (Claude Code)

In Claude Code:

```text
/plugin marketplace add EvoMap/evolver-agent-plugin
/plugin install evolver-plugin@evolver-agent-plugin
```

The marketplace installs `dist/claude-code` from the `release` branch, which CI builds from
every tested push to `main`; Node.js 22.13+ must be on the `PATH` (or set `node_path` in
`/config`). Restart Claude Code afterwards. To update, refresh the marketplace first, then the
plugin, and restart:

```bash
claude plugin marketplace update evolver-agent-plugin && claude plugin update evolver-plugin@evolver-agent-plugin
```

Claude Code updates an installed plugin only when its version changes, so a release meant
to reach installs bumps `version` in `hosts/claude-code/dist/.claude-plugin/plugin.json`. To
try a local build, `npm run pack` and add `<checkout>/dist/claude-code` as the marketplace.

Run one Evolver plugin, not several: if `evolver-mods@evolver-mods`, `evolver@evolver` or the earlier
`evolver-agent-plugin@evolver-agent-plugin` is installed, uninstall it so that each reuse is reported only once:

```bash
claude plugin uninstall evolver-agent-plugin@evolver-agent-plugin
claude plugin disable evolver-mods@evolver-mods
```

## Install (other hosts)

Every host installs the plugin as `evolver-plugin`. WorkBuddy, Codex, Antigravity and OpenCode install a folder
packed for them (`npm run pack`, into `dist/<host>`), from the `release` branch. Remove the host's standalone Evolver
plugin first, or every reuse is reported twice; the new one adopts what the old one left (turn counters, open
injections, undelivered reports), so nothing is lost on the way over.

- **WorkBuddy / CodeBuddy:** keep the old plugin's data when you remove it (WorkBuddy deletes a plugin's data
  folder on uninstall otherwise), then replace its marketplace, which has the same name:

  ```text
  /plugin uninstall evolver@evomap-workbuddy --keep-data   # again with --scope project where it was installed in a project
  /plugin marketplace remove evomap-workbuddy
  /plugin marketplace add EvoMap/evolver-agent-plugin
  /plugin install evolver-plugin@evomap-workbuddy
  ```

  The marketplace installs `dist/workbuddy` from the `release` branch, and the first session moves the old data
  folder's files (`evolver-evomap-workbuddy`) into the new one. WorkBuddy updates an installed plugin only
  when its version changes, so a release meant to reach installs bumps the version in
  `hosts/workbuddy/dist/.codebuddy-plugin/` and in `.codebuddy-plugin/marketplace.json` together. To try a local
  build, `npm run pack` and add `<checkout>/dist/workbuddy` as the marketplace instead: the packed folder is a
  marketplace of its own.
- **Codex:** remove the standalone plugin and its marketplace, then add this one at the `release` branch:

  ```bash
  codex plugin remove evolver@evomap && codex plugin marketplace remove evomap
  codex plugin marketplace add EvoMap/evolver-agent-plugin --ref release
  codex plugin add evolver-plugin@evomap
  ```

  Then open `/hooks` in Codex, trust the Evolver hooks, and start a new thread.
- **Cursor:** add this repository as a plugin marketplace and install `evolver-plugin`; it installs the repo itself.
- **Antigravity:** `agy plugin uninstall evolver-antigravity-plugin`, then from the `release` branch,
  `git clone --depth 1 --branch release https://github.com/EvoMap/evolver-agent-plugin.git` and
  `agy plugin install evolver-agent-plugin/dist/antigravity`.
  Its commands run from a terminal: `node <installed plugin>/bin/command.mjs antigravity evolver-status` (or
  `evolver-search <text>`, `evolver-distill`, `evolver-drafts publish 1`, …).
- **OpenCode:** `opencode plugin <release clone>/dist/opencode` (the folder is the `@evomap/evolver-opencode`
  package, not published to npm yet); remove the old `evolver-opencode-plugin` first, or every reuse is reported
  twice.
- **An MCP client without hooks:** in a checkout, `npm ci` (the server needs the MCP SDK), then register
  `node <checkout>/bin/mcp.mjs mcp-generic` as an stdio MCP server.

## Commands

| Command | What it does |
|---|---|
| `/evolver-status` | Proxy state, engine setup, the distillation candidate and waiting drafts |
| `/evolver-search <task or error text>` | Finds the best matching network strategy |
| `/evolver-distill [focus]` | Distills the last verified turn into a draft now |
| `/evolver-drafts [publish\|discard <number>]` | Lists drafts; publishes one for Hub review or drops it |
| `/evolver-evolve [focus]` | An evolution checkpoint the agent answers |

`/evolver-run`, `/evolver-review`, `/evolver-solidify` and `/evolver-sync` drive the Evolver CLI. How each host
reaches the commands is in `hosts/README.md`.

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
npm run pack
claude --plugin-dir dist/claude-code
```

## License

MIT © EvoMap.

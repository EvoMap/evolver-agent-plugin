# Architecture

Reference for `evolver-plugin`'s commands, settings and troubleshooting, then how it is built and the design
decisions behind its behaviour. Evolver ships as two projects for now: `evolver` (`@evomap/evolver`, the engine:
the local Proxy, the memory graph, the Hub link) and `evolver-plugin` (this repository, which connects every agent
to it and keeps the engine installed and running). They will merge into one.

## Commands

The plugin registers no tools: recall, reuse reports and distillation run from each host's hooks, plugin API or
MCP connection. The person drives Evolver through these commands, the same on every host (how each host reaches
them is in `hosts/README.md`):

| Command | Purpose |
|---|---|
| `/evolver-status` | Proxy state, engine setup, Hub sign-in, the session's distillation candidate and waiting drafts. |
| `/evolver-login` | Sign in to the EvoMap Hub: set Evolver up when its Proxy does not answer, start `evolver login` in the background and answer its link and code; once approved, the node the Proxy registered. |
| `/evolver-search <task or error text>` | Find the best matching strategy or Recipe. Where the host shows the answer to the model, it joins the injection ledger, so the turn's end reports its reuse. |
| `/evolver-distill [focus]` | Distill the session's last verified turn into a draft now, optionally steered by the focus text. |
| `/evolver-drafts [publish\|discard <number>]` | List drafts; publish one to the Hub for review through `POST /asset/submit`, or drop it. |
| `/evolver-evolve [focus]` | An evolution checkpoint the agent answers: recall, reflect, record the lesson. |
| `/evolver-sync`, `/evolver-review`, `/evolver-run`, `/evolver-solidify` | Run the `evolver` CLI in the project (`npx -y @evomap/evolver@2.0.47` when it is not installed), ten minutes at most. |

## Configuration

Every host honours these environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `HOME` / `USERPROFILE` | (unset) | User directory for Proxy settings and plugin state. A non-empty `HOME` wins. |
| `EVOMAP_PROXY_PORT` | `19820` | Fallback Proxy port when `~/.evolver/settings.json` names no URL. |
| `EVOLVER_RECALL` | (on) | `off` turns recall off. |

Claude Code's options, editable from the `/config` menu, set the same things for its relay process:

| Option | Default | Purpose |
|---|---|---|
| `proxy_port` | `$EVOMAP_PROXY_PORT`, then `19820` | Fallback Proxy port. |
| `recall_enabled` | `true` | Recall one strategy per prompt. |
| `auto_distill` | `true` | Distill the session's last verified turn after the session ends, with one completion on your plan. `/evolver-distill` works either way. |
| `node_path` | `node` | The Node.js 22.13+ that runs the relay. |

## Troubleshooting

State lives in `~/.evolver/state/` (WorkBuddy: its plugin data folder), every file named `<host>-<kind>`. The Hub sign-in is one for every host, as Evolver's identity home is: `~/.evolver/login/`.

- **Recall injects nothing.** Hub text recall usually takes 3–11 s and sometimes fails with a Hub 504, which the
  Proxy relays as HTTP 400. The Hub judges each recalled asset's fit to the session's task and returns only those
  that fit, so an off-topic prompt usually recalls nothing; the plugin adds no word-matching gate of its own. Engine
  reminders, markup and links are removed from the prompt first, and a strategy longer than 4000 characters is
  passed over.
- **Every reuse is reported twice.** A host's earlier Evolver plugin is enabled too: `evolver-mods` or
  `evolver-agent-plugin` on Claude Code, `evolver@evomap` on Codex, `evolver@evomap-workbuddy` on WorkBuddy,
  `evolver-antigravity-plugin`, `evolver-opencode-plugin`, or the npm `@evomap/dsh-evolver` in a dsh profile. The earlier `evolver-agent-plugin` 0.1.0 on Claude Code
  kept its state in Claude Code's plugin store, which `evolver-plugin` does not read.
- **A reuse report seems lost.** Reports wait in `<host>-reports-outbox.json` until the Proxy accepts them, retried
  at every turn end and session start for 8 days.
- **No draft after a verified turn.** A turn is a candidate only when it answered, its last test, build, lint or
  type-check passed, and it edited files or ran three commands; the candidate waits in `<host>-distill-pending.json`
  until its session ends. `/evolver-status` says whether one is waiting.
- **Claude Code: installed, but no recall or turn summary.** Check `claude plugin list` shows it enabled and that
  Claude Code is 2.1.286 or newer. Hooks modules of installed plugins are behind a Claude Code rollout flag
  (`tengu_plugin_hooks_modules`); a `--plugin-dir` working copy always loads them. The relay needs `node` on the
  `PATH`, or `node_path` set.

## Layers

The plugin is the access layer of Evolver. Every host goes through one stack, so a turn is recalled for, reported
and distilled the same way whichever agent runs it. Hosts differ in three ways, and each kind of difference has
exactly one owner:

| Difference | What varies | Owner |
|---|---|---|
| Channel | How an event arrives and its answer leaves: a hook process per event, a command script, a plugin inside the host's process, a relay process a host's module talks to, an MCP tool call, or the background worker a hook starts | `lib/channels/{hook,script,plugin,relay,mcp,worker}/` |
| Host | Within a channel: payload fields, how context is injected, where evidence comes from, how a turn ends, how a command is typed, what its standalone plugin left behind | `hosts/<host>/profile.js` |
| Execution | Process lifetime, locking, background work, time budgets, how a headless model and the CLI run, where state lives | `lib/runtime/`, assembled once per channel |

```
host ─▶ lib/channels/*  ─▶ lib/agent/driver.js ─▶ lib/app/*  (use cases over ports)
                 hosts/<host>/profile.js ┘           ▲
                                       lib/runtime/environment.js builds the ports
                                                      lib/*.js, lib/turn, lib/distill, lib/session: pure rules
```

Layer rules, checked by `test/architecture.test.js`: the pure rules import nothing else; `lib/app/` imports only
pure rules and never Node; `lib/runtime/` implements the ports and is the only shared code that spawns, locks,
reads files or branches on the platform; `hosts/<host>/` holds data and pure functions, no IO; `bin/` and every
`hosts/<host>/dist/` are entries that reach the plugin only through a channel; no shared layer names a host. Every
session id the use cases see is qualified with its host when it leaves (`claude-code:<session>:<turn>`), so task ids
and ledger cycles say which agent a report came from.

**Profiles.** `defineProfile` completes a host's profile with its channel's defaults and fails on load if a
difference point is missing. The points are the channel; the event map onto eight canonical events
(`sessionStart`, `prompt`, `toolResult`, `beforeEdit`, `turnEnd`, `sessionEnd`, `command`, `agentGene`); how to
read a payload; how a session starts (`event`, `owner-change`, `connection`); how to answer (the injection's shape,
an empty answer per event, whether an injection lasts the turn or one model call, how a recall slower than the
wait joins a running turn, and whether the strategy rides the prompt or waits for the turn's first tool result); where evidence comes from (tool hooks, or a transcript read from the turn's start); how
a turn ends (its reason, `'unknown'` to wait, and how long to wait for a late end); how commands are typed
(`intercept`, `inline-script`, `prompt`, `tool`, `cli-only`). The runtime executes what the profile declares: time
budgets per event, the owner process (`self`, `spawner`, `parent`, or a named ancestor), the headless model (a CLI, an SDK
call, the agent's own model in the session, or none) and the state directory, and what the host's standalone plugin
left in it (adopted once, so a resumed session keeps counting turns and nothing undelivered is lost).
`hosts/README.md` holds the matrix of every host against these points.

**Use cases** (`lib/app/`), each `(ports, input)`:

| Event | Use case | What it does |
|---|---|---|
| Session start | `sessionStarted` | Queues retention reports for an earlier session's edits and aborted reports for a killed session's injections (its owner process is gone); schedules engine setup, delivery and leftover distillation; answers the one-off engine notice, the only text besides a strategy that reaches the model. |
| Prompt | `promptSubmitted` | A correction drops the session's candidate, then the last turn's reuses are reported again under `:correction`. The turn counter moves on and survives the session's end, so a resumed session never repeats a task id. One strategy, or a Recipe expanded into one, is recalled within what is left of the hook's budget and ends with `Apply them where they fit.` |
| Tool result | `toolFinished`, `beforeEdit`, `takeWaitingStrategy`, `recallWhenStuck` | Notes each call: shell commands with their exit code (a run still going is settled by a later note, or counts as not run), edited paths, each file's hash before its first edit. Where the strategy waits for a tool result, the turn's first one takes it and books it, only while that turn is open; a turn with no tool call never gets it, and it is neither reported nor kept out of later recalls. Where a tool result's context reaches the model (`toolResultContext`, or a `tool-result` host), a failed test, build, lint or type-check recalls again, once per distinct failure and twice a turn at most, with a query built from its output and the turn's edits; a strategy that lands within the tool result's budget is added to that result and booked. |
| Turn end | `turnEnded` | Ends as `answer`, `aborted`, `refusal` or `error`. Every injection of the turn is reported (`applied: used`, tier `L1` when a check ran; tier `none` with `reported_by: agent` when the agent only reported its checks). A turn that answered, whose last check passed and that edited files or ran three commands, becomes the session's candidate. |
| Session end | `sessionEnded` | Only writes: a turn still open ends, what is unreported goes out as aborted, the candidate is closed for background distillation. |

**State** lives in one directory per host, every file named `<host>-<kind>`. Writes go through an exclusive lock with
dead-owner takeover; hooks only append reports to a queue, and one process at a time owns the outbox.

**Distillation** happens once a session, after it ends, outside the conversation: the host's model gets a digest of
the candidate turn, may answer `{"skip": …}`, and the Gene goes to `POST /conversation/distill` with
`trigger: session_end`. Without a host verifier, which only an isolated Linux Proxy has, the Proxy stores nothing
and answers the Gene and Capsule as a draft; it is kept in `<host>-distill-drafts.json` until the person publishes
or discards it with `evolver-drafts`. A correction while the model answers stops the post; a candidate is retried at
the next session start and given up after three failed tries, and one no model here can take waits a day for an
agent's Gene before it is dropped. A headless run carries `EVOLVER_HEADLESS=1`, which turns this plugin's hooks off
inside it. An agent with no model outside the conversation writes the Gene itself when asked.

**MCP.** An agent without hooks (Kiro, openclaw, any MCP client) runs `bin/mcp.mjs <host>`, an stdio server with seven
tools: `evolver_recall` (a turn starts), `evolver_report` (it ends, with the checks the agent ran), `evolver_distill`
(the Gene the report asked for), `evolver_status`, `evolver_search`, `evolver_drafts`, `evolver_login`. The connection is the
session. It shares every use case with the hook hosts, except that the evidence is the agent's own report, and that
there is no retention follow-up: the server never sees a file before the agent edits it. A session start's engine
notice leads the first recall's answer. An agent with hooks never uses it, so its model's context holds no Evolver
tool. The engine's `@evomap/evolver-mcp` is a separate, general tool server.

**Claude Code: the relay.** Claude Code runs a plugin as a hooks module with no Node, and `$` may only reach
functions declared in the module's own file (`claude plugin validate` refuses `$` crossing an import). So
`hosts/claude-code/dist/hooks/register.ts` only relays. On the first event of a session it starts
`bin/relay.mjs claude-code` with `$.process.spawn`, which prints `{ port, token }` once it listens on loopback; the
spawn's loop is the relay's life, so the relay ends with the module, and a relay that died is started again by the
next event. The module sends each event over `$.http.fetch` with that token, as the profile's host events, and
applies the answers: `$.session.append` for a strategy, `$.ui.toast` for a notice, `{ text, context }` for a
command, `$.prompt.submit` for `/evolver-evolve`, and the turn summary as `turn.complete`'s `{ text }`. Text
appended in `turn.start` never reaches the turn's first request, so a recall never waits there: the strategy is
appended when it lands, only while its turn is still open (and is then kept out of the session's later recalls), and
booked at the turn's next main-loop `turn.step` after the first; a turn that ends first books nothing. In the
relay, the plugin channel runs as for any in-process host, with the same file state as every other host. The
relay's model is the session's own: its distillations queue there, and the module pulls each one, runs it with
`$.model.complete` outside the conversation and posts the answer back. The relay's owner is the process that
started it (`spawner`), Claude Code itself, and the relay exits once that is gone. A relay that does not start
within 15 s is ended, and the next start waits longer after each failure.

**Packing and publishing.** WorkBuddy copies only its plugin folder and loads every component folder at that
folder's root, Antigravity installs a whole repo and loads its skills, commands and agents, OpenCode and DeepSeek
Harness load an npm package, and Claude Code, Codex, Grok and Qoder install a plugin folder: installed from this repo as it is, they would miss
`lib/` or load another host's files. `npm run pack` builds each of them its own folder under `dist/<host>`
(`scripts/pack.mjs`, from `hosts/<host>/dist/pack.json`): the files its entries load, at their paths here, and its
manifests at the root. Cursor installs the repo root: its manifest names its commands and hooks, which turns off its
folder discovery. `dist/` is not committed to `main`. CI (`.github/workflows/release.yml`) tests and packs every push
to `main`. A release is a tag `vX.Y.Z` a maintainer pushes on `main`, and nothing on `main` names a version: CI
packs with the tag's version stamped into every host's manifest (`scripts/pack.mjs --version`), and
`scripts/publish-tag.sh` moves the `release` branch one commit on, the tagged source plus `dist/`, and re-points the
tag at it, in one atomic push. A tag off `main`, or older than what `release` holds, is refused; a re-run changes
nothing. The repo root keeps only the marketplace manifests the
hosts read at fixed paths. Claude Code's, WorkBuddy's, Codex's, Grok's and Qoder's install `dist/<host>` from `release` through a
`git-subdir` source, since a marketplace itself is read from `main`; the marketplace entries name no version, so each host reads the
stamped one from the packed manifest; Antigravity, OpenCode and DeepSeek Harness install from a clone of it.

**Engine.** When no Proxy of `2.0.47` or newer answers, a session start installs or upgrades `@evomap/evolver` under
`<state>/<host>-engine/` in the background and starts its Proxy, without the self-update service.

## Layout

```
.claude-plugin/ .codebuddy-plugin/ .cursor-plugin/ .agents/plugins/ .grok-plugin/ .qoder-plugin/
                       marketplace manifests, where each host reads them
bin/                   entries: hook.mjs, worker.mjs, command.mjs, mcp.mjs, relay.mjs <host>
hosts/<host>/          profile.js and its pure readers; dist/ holds what the host installs
lib/channels/          how events arrive (hook, script, plugin, relay, mcp, worker)
lib/agent/             profiles, the canonical events, the driver
lib/app/               use cases over ports
lib/runtime/           the ports: file state and locks, processes, headless models, Proxy, engine setup
lib/*.js, lib/turn/, lib/distill/, lib/session/
                       host-neutral pure rules: recall ranking, Recipe expansion, relevance and redaction, reuse
                       reports and their evidence, outbox, injection ledger, follow-up labels, retention,
                       verification, savings, turn summary, distillation and drafts
scripts/               pack.mjs, publish-tag.sh
```

## Design decisions

- **Fit is the Hub's call.** Every recall carries the session's task as `context`, and the Hub has a model judge
  each recalled asset's fit to that task before it answers. The plugin keeps what the Hub answers and adds no
  word-matching gate of its own: counting words a prompt shares with an asset dropped on-topic Chinese prompts, since
  a Han bigram weighed half a Latin word, and every asset described in another language than the prompt. Before
  recall, `<system-reminder>` blocks, markup and links are stripped from the prompt, so a session notification
  recalls nothing. A strategy that would inject more than 4000 characters is passed over. A Recipe search still
  checks the terms a Recipe's title and description share with the prompt (`lib/relevance.js`), until it carries the
  Hub's verdict too.
- **Recipes.** A Recipe is an ordered chain of strategies. Each prompt is searched for Recipes
  (`POST /recipe/search`) alongside the text recall, both at once, and a fitting Recipe comes before a single
  strategy. It must pass the relevance gate on its title and description, which is all a search returns about it;
  its steps' assets are then fetched by id through `/asset/fetch`, billed per asset as any fetch is, and shown in
  order under one heading each. A Recipe missing a required step, left with fewer than two, or longer than 6000
  characters is passed over for the next one, then for a single strategy. Each step is booked in the injection
  ledger under its own asset id and its own text, read as a single strategy of the step's name, so every report
  (turn end, correction, retention) and the turn summary go step by step; the Recipe's id is never reported. A
  Recipe whose required steps the session has seen is passed over before its steps are fetched, so an optional
  step the Hub did not return never brings it back.
- **Task context.** Every recall sends `context` beside `text`: an object the Hub defines and the Proxy forwards
  whole, here `{ task, trigger, language? }`. `task` is the session's first typed prompt (1500 characters, cleaned as
  a prompt is), `trigger` is `turn_start` or `check_failed`, and `language` the touched files' languages. The Hub
  judges each recalled asset's fit to the task with it, never recalls by it. The first 400 characters of a prompt are
  often its boilerplate, and an error line alone names no task: an offline replay of 53 SWE runs fired on 15 failed
  checks, and judged with the task and the failure together the Gene distilled for the task ranked first in all 14
  pools that held it.
- **Estimated savings.** Claude Code's turn summary claims a saving only when the turn's last check passed, and never
  more than the fresh tokens (input, cache writes, output) the turn spent: evolver-core's estimator prices deriving a
  whole approach from scratch, which put ~72k against single questions that cost 5k.
- **Strategy timing on Claude Code.** `turn.start` holds no request, so a strategy reaches the model from the turn's
  next step and a turn answered in one step never sees it. Attaching it as `prompt.submit` context would reach the
  first request but holds the person's message off screen until recall returns (3.6–5.7 s measured); that trade was
  declined.
- **Strategy timing on Grok.** grok 1.0.70 discards what an allowing `UserPromptSubmit` hook prints, so the
  strategy waits for the turn's first tool hook. A `PreToolUse` and a `PostToolUse` context both land right after
  that tool's result, as a `<system-reminder>` user message kept in later requests (measured on a fake model), but a
  `PreToolUse` one is dropped when any hook denies the call or the person rejects it, so `PostToolUse` (and
  `PostToolUseFailure`) carries it. A turn answered without a tool call never sees it. grok names no turn on a tool
  result, so a late result of an interrupted turn could carry the next turn's strategy; no payload field tells them
  apart.
- **Reuse reports.** Every injection is reported, through the Proxy's `POST /asset/reuse-result`, as
  `{asset_id, outcome, task_id, reason, evidence}`; the field names are shared with the Hub and Evolver. `reason`
  names the turn and the check kind, never the prompt, a command, code or a diff, and the prompt loses keys and
  tokens before recall sends it.

  | Report | `task_id` | `evidence` |
  |---|---|---|
  | Turn end | `<host>:<session>:<turn>` | `tier` `L1` when a check ran, else `none`; `applied: used`; `check` `{kind, passed, fail_then_pass}`; `aborted`; `stage: immediate` |
  | Next prompt corrects or approves | `…:correction` | `tier: L3`, `applied`, `stage: correction` |
  | Next session finds the edits kept or reverted | `…:retention` | `tier: L2`, `applied`, `stage: retention` |

  An injected strategy counts as used (dsh #55): the plugin cannot tell from a turn's evidence whether the model
  followed it, and a reused turn is distilled like any other, the engine's intake dropping a Gene it already has.
  `fail_then_pass` compares checks with output trimming (`| tail -9`, `2>&1`) removed, so the same check piped
  differently is still the same check. The outcome follows the last check; with none it follows how the turn ended.
  A tier `none` report counts as exposure only on the Hub and is not written to the local ledger. An older Proxy
  drops the new fields and the plugin runs unchanged.
- **Report outbox.** Reports are keyed by task id and asset, queued once and retried for 8 days, long enough for a
  retention follow-up a week later. A report counts as delivered once the Hub answers it at all: `recorded`,
  `duplicate_report`, or `eligible: false` (`daily_cap`, `same_owner`, `no_delivery_proof`) are final, so only an
  unreachable Proxy or an unrecorded answer is retried. The Hub counts one turn-end report per node, asset and UTC
  day. A request the Hub refuses as invalid can never succeed: the Proxy marks it `terminal: true` (an older one
  says `hub 400` or `hub 422`), and the report is settled as rejected and kept out of the local ledger. `hub 404`
  (the Hub may not serve the route yet), `hub 5xx`, 401, 403, 429 and timeouts are retried until the report expires.
- **Turn numbers** come from a per-session counter, one per turn whatever started it, kept past the session's end:
  a resumed session continues under the same id, and a repeated task id is one the Hub drops as a duplicate.
- **Subagents** get no recall; their checks and edits count toward the main turn.

## Claude Code engine behaviour found while testing

- A `hooks.json` that lists `modules` still runs its command `hooks`.
- A symlinked plugin folder loads once and is never reloaded.
- The engine writes `.claude-plugin/types/` into a module's folder on every load; a sync that deletes it triggers a
  second reload, reported as "plugin.json changed".
- The desktop app draws `$.ui.toast` (top right, gone after its timeout), `$.ui.status` (a line under the prompt)
  and an `AbovePrompt` band. `turn.complete`'s `{ text }` is drawn as a "Claude Code notice" under the answer,
  without line breaks; the turn summary stays there because it is a record of that turn, kept in the transcript.
- Gating hooks (`prompt.submit`, `tool.call`) need a `.catch` from 2.1.293 on; its `next` is replay-safe, so a
  failure after `next` never runs the tool twice.
- A marketplace-installed copy loads `modules` as `<plugin>@<marketplace>` (`evolver-plugin@evolver-agent-plugin`),
  tier `user`, the same as a `--plugin-dir` copy; installed plugins' modules wait on the `tengu_plugin_hooks_modules`
  rollout flag first.
- `claude -p` on 2.1.308 runs a module's `session.start`, `prompt.submit` (origin `sdk`), `turn.start`,
  `turn.complete` and `session.end`, even when the model call fails (`reason: "error"`); the captured inputs are in
  `test/fixtures/claude-code/events.json`.

## Development

```bash
npm ci
npm test
npx -p typescript tsc -p .
npm run validate
```

`tsconfig.json` reads `.claude/types/claude-code.d.ts`; write it with `/plugin-types` after each Claude Code
update. `npm run validate` packs `dist/claude-code` and runs `claude plugin validate` on it, which needs Claude Code
2.1.286 or newer; an older `claude` on `PATH` validates the plugin as having no hooks. Installed copies update by
version: bump `version` in a host's manifest with every change meant to reach its users, or the host reports the old
version as the latest.

## Open questions

- Whether `@evomap/evolver-core`'s terms allow redistributing a plugin that imports it.

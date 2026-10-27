# Architecture

Reference for the plugin's commands, settings and troubleshooting, then how it is built
and the design decisions behind its behaviour.

## Layers

The plugin is the access layer of Evolver. `lib/` holds host-neutral logic: it never
names a host, and every session id it receives is already qualified with one
(`claude-code:<session>`), so task ids and ledger cycles say which agent a report came
from. A host adapter owns all of that host's IO and turns its hook events into `lib/`
calls, speaking `lib/`'s vocabulary: a turn ends as `answer`, `aborted`, `refusal` or
`error`, and a check is `{ command, failed }`. Claude Code's adapter is
`hooks/register.ts`, with the parsing of its own tool calls (which calls edit files,
what they wrote, which shell runs are checks) in `lib/claude-code/`; the sections below
that name events describe it. Other agents run through the stack described next, not as separate plugins.

## Agents beyond Claude Code

Every other agent goes through one stack, so a turn is recalled for, reported and distilled the same way
whichever agent runs it. Agents differ in three ways, and each kind of difference has exactly one owner:

| Difference | What varies | Owner |
|---|---|---|
| Channel | How an event arrives and its answer leaves: a hook process per event, a command script, a plugin inside the host's process, an MCP tool call, or the background worker a hook starts | `lib/channels/{hook,script,plugin,mcp,worker}/` |
| Host | Within a channel: payload fields, how context is injected, where evidence comes from, how a turn ends, how a command is typed, what its standalone plugin left behind | `hosts/<host>/profile.js` |
| Execution | Process lifetime, locking, background work, time budgets, how a headless model and the CLI run, where state lives | `lib/runtime/`, assembled once per channel |

```
host ─▶ lib/channels/*  ─▶ lib/agent/driver.js ─▶ lib/app/*  (use cases over ports)
                 hosts/<agent>/profile.js ┘          ▲
                                       lib/runtime/environment.js builds the ports
                                                      lib/*.js, lib/turn, lib/distill, lib/session: pure rules
```

Layer rules, checked by `test/architecture.test.js`: the pure rules import nothing else; `lib/app/` imports only
pure rules and never Node; `lib/runtime/` implements the ports and is the only shared code that spawns, locks,
reads files or branches on the platform; `hosts/<host>/` holds data and pure functions, no IO; `bin/` and every
`hosts/<host>/dist/` are entries that reach the plugin only through a channel; no shared layer names a host.

**Profiles.** `defineProfile` completes an agent's profile with its channel's defaults and fails on load if a
difference point is missing. The points are the channel; the event map onto eight canonical events
(`sessionStart`, `prompt`, `toolResult`, `beforeEdit`, `turnEnd`, `sessionEnd`, `command`, `agentGene`); how to
read a payload; how a session starts (`event`, `owner-change`, `connection`); how to answer (the injection's shape,
an empty answer per event, whether an injection lasts the turn or one model call); where evidence comes from (tool
hooks, or a transcript read from the turn's start); how a turn ends (its reason, `'unknown'` to wait, and how long
to wait for a late end); how commands are typed (`intercept`, `inline-script`, `prompt`, `tool`, `cli-only`). The
runtime executes what the profile declares: time budgets per event, the owner process (`self`, `parent`, or a named
ancestor), the headless model (a CLI, an SDK call, the agent's own model in the session, or none) and the state
directory, and what the host's standalone plugin left in it (adopted once, so a resumed session keeps counting turns
and nothing undelivered is lost). `hosts/README.md` holds the matrix of every host against these points.

**Use cases** (`lib/app/`), each `(ports, input)`:

| Event | Use case | What it does |
|---|---|---|
| Session start | `sessionStarted` | Queues retention reports for an earlier session's edits and aborted reports for a killed session's injections (its owner process is gone); schedules engine setup, delivery and leftover distillation; answers the one-off engine notice, the only text besides a strategy that reaches the model. |
| Prompt | `promptSubmitted` | A correction drops the session's candidate, then the last turn's reuses are reported again under `:correction`. The turn counter moves on and survives the session's end, so a resumed session never repeats a task id. One strategy is recalled within what is left of the hook's budget and ends with `Apply them where they fit.` |
| Tool result | `toolFinished`, `beforeEdit` | Notes each call: shell commands with their exit code (a run still going is settled by a later note, or counts as not run), edited paths, each file's hash before its first edit. |
| Turn end | `turnEnded` | Ends as `answer`, `aborted`, `refusal` or `error`. Every injection of the turn is reported (`applied: used`, tier `L1` when a check ran; tier `none` with `reported_by: agent` when the agent only reported its checks). A turn that answered, whose last check passed and that edited files or ran three commands, becomes the session's candidate. |
| Session end | `sessionEnded` | Only writes: a turn still open ends, what is unreported goes out as aborted, the candidate is closed for background distillation. |

**State** lives in one directory per agent (`~/.evolver/state` unless the profile says otherwise), every file named
`<agent>-<kind>`. Writes go through an exclusive lock with dead-owner takeover; hooks only append reports to a
queue, and one process at a time owns the outbox.

**Distillation** happens once a session, after it ends, outside the conversation: the agent's headless model gets a
digest of the candidate turn, may answer `{"skip": …}`, and the Gene goes to `POST /conversation/distill` with
`trigger: session_end`. Without a host verifier, which only an isolated Linux Proxy has, the Proxy stores nothing
and answers the Gene and Capsule as a draft; it is kept in `<agent>-distill-drafts.json` until the person publishes
or discards it with `evolver-drafts`, as on Claude Code. A correction while the model answers stops the post; a
candidate is retried at the next session start and given up after three failed tries. The headless run carries
`EVOLVER_HEADLESS=1`, which turns this plugin's hooks off inside it. An agent with no headless model writes the
Gene itself when asked.

**MCP.** An agent without hooks (Kiro, openclaw, any MCP client) runs `bin/mcp.mjs <agent>`, an stdio server with six
tools: `evolver_recall` (a turn starts), `evolver_report` (it ends, with the checks the agent ran), `evolver_distill`
(the Gene the report asked for), `evolver_status`, `evolver_search`, `evolver_drafts`. The connection is the
session. It shares every use case with the hook agents, except that the evidence is the agent's own report, and
that there is no retention follow-up: the server never sees a file before the agent edits it. A session start's
engine notice leads the first recall's answer. An agent with hooks never uses it, so its model's context holds no
Evolver tool. The engine's `@evomap/evolver-mcp` is a
separate, general tool server.

**Packing.** WorkBuddy copies only its plugin folder and loads every component folder at that folder's root,
Antigravity installs a whole repo and loads its skills, commands and agents, and OpenCode loads an npm package:
installed from this repo as it is, they would miss `lib/` or load the Claude Code plugin's skill, commands and hooks.
`npm run pack` builds each of them its own folder under `dist/<host>` (`scripts/pack.mjs`, from
`hosts/<host>/dist/pack.json`): the files its entries load, at their paths here, and its manifests at the root.
Cursor installs the repo root: its manifest names its commands and hooks, which turns off its folder discovery.
`dist/` is not committed to `main`. CI (`.github/workflows/release.yml`) tests and packs every push to `main` and
`scripts/publish-release-branch.sh` commits `main` plus `dist/` to the `release` branch, one commit per build and
never a force-push. WorkBuddy's marketplace installs `dist/workbuddy` from there (a `git-subdir` source, since a
marketplace itself cannot be added at a branch); Antigravity and OpenCode install from a clone of it.

**Engine.** When no Proxy of `2.0.44` or newer answers, a session start installs or upgrades `@evomap/evolver` under
`<state>/<agent>-engine/` in the background and starts its Proxy, without the self-update service.

## Commands

The plugin registers no tools: recall, reuse reports and distillation all run from hooks.
The person drives the Proxy through commands its hooks answer:

| Command | Purpose |
|---|---|
| `/evolver-status` | Proxy state: node id, pending counts, last Hub sync. |
| `/evolver-search <task or error text>` | Recall the best matching strategy for the text and add it to the conversation; it joins the injection ledger, so the next turn's end reports its reuse. |
| `/evolver-distill [focus]` | Distill the session's last verified turn into a draft, optionally steered by the focus text. |
| `/evolver-drafts [publish\|discard <number>]` | List drafts; publish one to the Hub for review through `POST /asset/submit`, or drop it. |

## Skill and commands

A **`capability-evolver` skill** (the reuse → verify → record loop) and the commands
**`/evolver-agent-plugin:evolve`**, plus **`/evolver-agent-plugin:run`**, **`/evolver-agent-plugin:review`**,
**`/evolver-agent-plugin:solidify`** and **`/evolver-agent-plugin:sync`** when `@evomap/evolver` is installed.

## Configuration

Options, editable from the `/config` menu:

| Option | Default | Purpose |
|---|---|---|
| `proxy_port` | `$EVOMAP_PROXY_PORT`, then `19820` | Fallback Proxy port when `~/.evolver/settings.json` names no URL. |
| `recall_enabled` | `true` | Recall one strategy per prompt. |
| `recall_min_similarity` | `0.3` | Lowest similarity worth injecting, when the Proxy reports one. The relevance check applies either way. |
| `recall_wait_ms` | `6000` | How long recall is awaited when the turn starts before it finishes in the background. |
| `auto_distill` | `true` | Distill a turn that edited files and ended on a passing check into a draft. Each one spends one forked completion from the plan. `/evolver-distill` works either way. |
| `claim_nudge_enabled` | `false` | Show a toast with the pending node-claim link at most every 12 hours. |
| `node_path` | `node` | The Node.js the sidecar runs on. |

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `HOME` / `USERPROFILE` | (unset) | User directory for Proxy settings and claim reminders. A non-empty `HOME` wins; otherwise `USERPROFILE` is used on Windows. If both are missing, no user credential or claim file is read. |
| `EVOMAP_PROXY_PORT` | `19820` | Fallback Proxy port. |

## Troubleshooting

- **Nothing seems to happen after a recall.** Recall decisions and background failures
  are kept in the plugin's store: open `~/.claude/plugins/store/evolver-agent-plugin_*.json` and
  look under `recalls` and `errors`.
- **Recall injects nothing.** Hub text recall usually takes 3–11 s and sometimes fails
  with a Hub 504, which the Proxy relays as HTTP 400. Requests time out after 8 s. A
  strategy is also skipped when its relevance to your prompt is below 2. Each shared
  English word counts 1 and each shared pair of Chinese characters counts 0.5, so a
  short or off-topic prompt injects nothing by design. Engine reminders, markup and
  links are removed from the prompt first, and a strategy longer than 4000 characters
  is passed over.
- **Every reuse is reported twice.** Another Evolver plugin (`evolver-mods` or the
  command-hook `evolver`) is enabled too.
- **No draft after a verified turn.** Open the plugin's store and look under `distills`:
  `not-reusable` means the read-back found no general lesson, `skipped:<reason>` names
  the Proxy gate that refused it (`insufficient_reusable_signal` most often), and
  `no-reply:<reason>` means the fork got no answer. A turn counts as verified only when
  it edited a file and its last test, build, lint or type-check passed.
- **A reuse report seems lost.** Reports wait in the plugin's store under
  `reports:outbox` until the Proxy accepts them, retried at every turn end, follow-up
  prompt and session start for 8 days; `sentAt` marks the delivered ones and
  `rejectedAt` the ones the Hub refused, with the reason beside it.
- **Installed, but no recall, signals or turn summary.** Check
  `claude plugin list` shows it enabled and that Claude Code is 2.1.286 or newer. Hooks
  modules of installed plugins are behind a Claude Code rollout flag
  (`tengu_plugin_hooks_modules`); a `--plugin-dir` working copy always loads them.
- **Validation passes but lists no hooks.** The `claude` on your `PATH` is older than
  2.1.286. Use the one the desktop app bundles.

## Development

```bash
npm ci
npm test
npx -p typescript tsc -p .
claude plugin validate .
```

`tsconfig.json` reads `.claude/types/claude-code.d.ts`; write it with `/plugin-types`
after each Claude Code update. `claude plugin validate` needs Claude Code 2.1.286 or newer;
an older `claude` on `PATH` validates the plugin as having no hooks.

A `--plugin-dir` folder is watched and reloads on save. A symlink into a watched folder
loads once and is never reloaded, so for a session's `~/.claude/dev-mods/<session>/`
folder sync a real copy instead:

```bash
npm run dev:sync -- ~/.claude/dev-mods/<session>/evolver-claude-mods
```

Installed copies update by version: bump `version` in `.claude-plugin/plugin.json`
(and `package.json`) with every change meant to reach them, or
`claude plugin update` reports the old version as the latest.

## Layout

```
hooks/register.ts      Claude Code adapter, the only file that touches `$` — every IO call lives here
lib/claude-code/       Claude Code's tool-call shapes: edits, written content, shell checks
lib/*.js               host-neutral pure logic (signals, recall ranking, relevance and redaction,
                       reuse reports and their evidence, report outbox, injection
                       ledger, follow-up labels, retention, verification, savings,
                       turn summary, distillation and drafts, Proxy status)
lib/local-ledger.js    Node-only code, run by the sidecar
bin/evolver-io.mjs     sidecar: `record-reuse`, JSON on stdin/stdout
```

Two engine rules shape this split:

1. **A hooks module has no Node.** evolver-core's `Ingestor` (hash-chained
   `root_events.jsonl`) therefore runs in a Node sidecar, which `register.ts` reaches
   through `$.process.run` the first time it delivers a report with evidence.
2. **`$` may only be passed to functions declared in the same file.** `claude plugin
   validate` refuses `$` crossing an import, so `register.ts` owns all IO and hands
   closures (`proxyFetch`, `recordLocally`, `onTrace`) to the pure `lib/` functions.

## Events

| Concern | Claude Code event | Notes |
|---|---|---|
| Recall | `prompt.submit` marks · `turn.start` recalls | `prompt.submit` knows the prompt's `origin` (`composer`, `bridge`, `sdk`, `scheduled-trigger` count as the person) but resolves only after its turn started, so the prompt is marked before `next`. `turn.start` is observe-only: the strategy is appended with `$.session.append` and reaches the model from the turn's next step. A recall slower than the wait is appended when it lands, unless the turn was interrupted. A prompt folded into a running turn is not recalled for: one recall per turn. |
| Correction follow-up | `prompt.submit` | The next `composer` prompt after a turn is labelled once: a correction or an approval reports that turn's reuse again. |
| Retention follow-up | `session.start` | Turns of an earlier session in the same project are judged by whether the files they edited are kept or reverted. |
| Edit signals | `tool.call` after `next` | The notice rides the result's `context`, as a PostToolUse reminder does. |
| Checks | `tool.call` on Bash | Every test, build, lint and type-check command of the turn, in order; background runs are ignored. Commands, paths, the text each edit wrote (200,000 characters a turn at most, in memory only) and each edited file's content hash before its first edit are kept for the turn too. |
| Turn end | `turn.complete` | Subagent turns (`agentId`) are skipped. Queues a reuse report for every injection the turn saw, returns the one-line summary as `{ text }`. |
| Session end | `session.end` | Drains pending work, forgets the session's ledger, turn counter and follow-up label. |
| Distill | `turn.complete` | A person's turn that answered, edited files and ended on a passing check is read back with one `$.model.fork` in the background, then sent to `POST /conversation/distill`; a passing draft is kept and announced with a toast. |
| Commands | `$.command.register` in `session.start` + `command.run` | Each command's hook answers `{ text }`; a failure falls through to `next`. |

## Design decisions

- **Relevance gate.** The local Proxy's text recall reports no similarity, and the Hub's
  raw order put off-topic genes behind short follow-ups. A candidate must share terms
  with the prompt through its title, summary and `signals_match`: Latin words are
  stemmed and weigh 1, Han bigrams weigh 0.5, generic task words and the host's own
  name (`claude`, `code`) nothing, and 2 passes. Measured on live recalls, every hit
  that scored 1.5 was off-topic and on-topic ones scored 2 or more; the samples are in
  `test/fixtures/recall-live.json`. Before matching, `<system-reminder>` blocks, markup
  and links are stripped from the prompt, so a session notification recalls nothing.
  A strategy that would inject more than 4000 characters is passed over. Two off-topic
  hits still score exactly 2 (meta questions sharing words like `replay` and `review`),
  the same as an on-topic Redis fix, so the gate alone cannot separate them.
- **Estimated savings.** The turn summary claims a saving only when the turn's last
  check passed, and never more than the fresh tokens (input, cache writes, output) the
  turn spent: evolver-core's estimator prices deriving a whole approach from scratch,
  which put ~72k against single questions that cost 5k.
- **Strategy timing.** `turn.start` holds no request, so a strategy reaches the model
  from the turn's next step and a turn answered in one step never sees it. Attaching
  it as `prompt.submit` context would reach the first request but holds the person's
  message off screen until recall returns (3.6–5.7 s measured); that trade was declined.
- **Reuse reports.** Every injection is reported, through the Proxy's
  `POST /asset/reuse-result`, as `{asset_id, outcome, task_id, reason, evidence}`; the
  field names are shared with the Hub and Evolver. `reason` names the turn, the applied
  verdict and the check kind, never the prompt, a command, code or a diff, and the
  prompt loses keys and tokens before recall sends it.

  | Report | `task_id` | `evidence` |
  |---|---|---|
  | Turn end | `claude-code:<session>:<turn>` | `tier` `L1` when a check ran, else `none`; `applied`; `check` `{kind, passed, fail_then_pass}`; `aborted`; `stage: immediate` |
  | Next prompt corrects or approves | `…:correction` | `tier: L3`, `applied`, `stage: correction` |
  | Next session finds the edits kept or reverted | `…:retention` | `tier: L2`, `applied`, `stage: retention` |

  `applied` is `used` when at least half the strategy's steps show up in the turn's
  commands, edited paths, written code or answer, `partial` when fewer do and `unused`
  when none do. A step shows up when a name, path or command it quotes appears, or
  half its words do. The written code has to count: a strategy carried out in code
  and summed up in another language shares no word with the answer. When there is
  nothing to compare, a strategy without numbered steps or a turn that left only an
  answer, the verdict is unknown. The Hub's contract has no such value and charges
  `unused` a soft negative, so an unknown reuse is sent as tier `none` with `applied:
  partial`, which weighs nothing either way, and the reason says `applied: unknown`.
  `fail_then_pass` compares checks with output trimming (`| tail -9`, `2>&1`) removed,
  so the same check piped differently is still the same check.
  The outcome follows the last check; with none it follows how the turn ended. A tier
  `none` report counts as exposure only on the Hub and is not written to the local
  ledger. An older Proxy drops the new fields and the plugin runs unchanged.
- **Report outbox.** Reports are keyed by task id and asset, queued once and retried
  for 8 days, long enough for a retention follow-up a week later. A report counts as
  delivered once the Hub answers it at all: `recorded`, `duplicate_report`, or
  `eligible: false` (`daily_cap`, `same_owner`, `no_delivery_proof`) are final, so
  only an unreachable Proxy or an unrecorded answer is retried. The Hub counts one
  turn-end report per node, asset and UTC day. A request the Hub refuses as invalid
  can never succeed: the Proxy marks it `terminal: true` (an older one says
  `hub 400` or `hub 422`), and the report is settled as rejected, kept
  out of the local ledger and logged under `errors` as `reuse-report-rejected`, where
  a contract mismatch shows up. `hub 404` (the Hub may not serve the route yet),
  `hub 5xx`, 401, 403, 429 and timeouts are retried until the report expires.
- **Distillation.** A hook observes no lesson, only evidence, so the lesson is read back
  with one tool-less `$.model.fork` over the session's own transcript, which the API
  serves from the prompt cache; it answers a JSON lesson or `{"reusable": false}`, and
  anything incomplete or carrying a secret is dropped. The request carries the turn's
  checks as an execution trace, each command once as its last run (an earlier failure
  of the same command is the fix's history), the passing ones as validation, and edited
  paths relative to the project. It asks for neither persistence nor publication: the
  Proxy stores a successful distillation only when a host verifier re-runs its
  validation, which only an isolated Linux Proxy with `EVOLVER_NATIVE_PUBLISH_VERIFIER`
  provides, so elsewhere the answer is a draft. A draft that passed the Proxy's quality
  gate is kept in `$.store` (20 at most, 8 days) until the person publishes it, which
  submits its Gene and Capsule for Hub review under a stable request id, or discards it.
  Each outcome (`drafted`, `not-reusable`, `skipped:<reason>`) is logged under `distills`.
- **Turn numbers** come from a per-session counter in `$.store`, one per turn whatever
  started it: `$.session.turns()` counts only the person's prompts, so a turn a task
  notification starts would reuse the previous number and its report would share that
  turn's task id.
- **State.** The injection ledger, report outbox, pending retention checks, recall
  traces, distill drafts and outcomes, and background failures live in the plugin's
  `$.store`.
- **Timeouts.** `$.http.fetch` takes neither a timeout nor an abort signal: every Proxy
  call races an 8 s `$.clock.sleep`, and an interrupted turn cannot cancel a request
  already sent.
- **Subagents** get no recall; their checks and edits count toward the main turn.
- **Onboarding notices** (upgrade, claim link) are toasts for the person, not model
  context.

## Engine behaviour found while testing

- A `hooks.json` that lists `modules` still runs its command `hooks`.
- A symlinked plugin folder loads once and is never reloaded.
- The engine writes `.claude-plugin/types/` into a mod's folder on every load; a sync that
  deletes it triggers a second reload, reported as "plugin.json changed".
- The desktop app draws `$.ui.toast` (top right, gone after its timeout), `$.ui.status`
  (a line under the prompt) and an `AbovePrompt` band. `turn.complete`'s `{ text }` is
  drawn as a "Claude Code notice" under the answer, without line breaks; the turn
  summary stays there because it is a record of that turn, kept in the transcript.
- Gating hooks (`prompt.submit`, `tool.call`) need a `.catch` from 2.1.293 on; its `next`
  is replay-safe, so a failure after `next` never runs the tool twice.

- A marketplace-installed copy loads `modules` as `evolver-agent-plugin@evolver-agent-plugin`, tier
  `user`, the same as a `--plugin-dir` copy; installed plugins' modules wait on the
  `tengu_plugin_hooks_modules` rollout flag first.
- The marketplace installer runs an npm install in the plugin's folder, so
  `@evomap/evolver-core` is there; the sidecar still falls back to the copy inside the
  global `@evomap/evolver` CLI when it is not.

## Open questions

- Whether `@evomap/evolver-core`'s terms allow redistributing a plugin that imports it.

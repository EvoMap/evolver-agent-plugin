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
| `/evolver-status` | Proxy state, engine setup, Hub sign-in, the session's work turns waiting to be distilled, the last distillation's outcome (its status, the Proxy's reason and the terms it refused, how long ago) and waiting drafts; where the Proxy reports it, its background publishing: whether its verifier is available and why not, how many Genes await verification or were published, and the last attempt's result. |
| `/evolver-login` | Sign in to the EvoMap Hub: set Evolver up when its Proxy does not answer, start `evolver login` in the background and answer its link and code; once approved, the node the Proxy registered. |
| `/evolver-search <task or error text>` | Find the best matching strategy or Recipe. Where the host shows the answer to the model, it joins the injection ledger, so the turn's end reports its reuse. |
| `/evolver-distill [focus]` | Distill the session's work since its last distillation into drafts now, optionally steered by the focus text. It waives the three-turn threshold, never the passing last check. |
| `/evolver-drafts [publish\|discard <number>]` | List drafts; publish one to the Hub for review through `POST /asset/submit`, or drop it. |
| `/evolver-evolve [focus]` | An evolution checkpoint the agent answers: recall, reflect, record the lesson. |
| `/evolver-sync`, `/evolver-review`, `/evolver-run`, `/evolver-solidify` | Run the `evolver` CLI in the project (`npx -y @evomap/evolver@2.0.50` when it is not installed), ten minutes at most. |

## Configuration

Hosts whose native environment preserves them honour these environment variables. MiniMax strips inherited
Evolver flags from hooks; its persistent preferences are described below.

| Variable | Default | Purpose |
|---|---|---|
| `HOME` / `USERPROFILE` | (unset) | User directory for Proxy settings and plugin state. A non-empty `HOME` wins. |
| `EVOMAP_PROXY_PORT` | `19820` | Fallback Proxy port when `~/.evolver/settings.json` names no URL. |
| `EVOLVER_RECALL` | (on) | `off` turns recall off. |
| `EVOLVER_AUTO_DISTILL` | (on) | `off` leaves distillation to an explicit command. |

MiniMax stores boolean `recall` and `autoDistill` preferences in `<PLUGIN_DATA>/minimax-settings.json`.
`evolver-config recall off` and `evolver-config auto-distill off` update them without opening a model turn.
Status reports the effective values and any invalid preferences; invalid/unreadable files pause both automatic
activities instead of silently enabling them. Explicit environment values win where the host preserves them.

Claude Code's options, editable from the `/config` menu, set the same things for its relay process:

| Option | Default | Purpose |
|---|---|---|
| `proxy_port` | `$EVOMAP_PROXY_PORT`, then `19820` | Fallback Proxy port. |
| `recall_enabled` | `true` | Recall one strategy per prompt. |
| `auto_distill` | `true` | Distill the session's verified work once it holds three work turns or a fixed error, 10 minutes after the fix, 30 minutes after the session went quiet or when it ends, with one completion on your plan. `/evolver-distill` works either way. |
| `node_path` | `node` | The Node.js 22.13+ that runs the relay. |

## Troubleshooting

State lives in `~/.evolver/state/` (WorkBuddy and MiniMax: their plugin data folders), every file named `<host>-<kind>`. The Hub sign-in is one for every host, as Evolver's identity home is: `~/.evolver/login/`.

- **Recall injects nothing.** Hub text recall usually takes 3–11 s and sometimes fails with a Hub 504, which the
  Proxy relays as HTTP 400. The Hub judges each recalled asset's fit to the session's task and returns only those
  that fit, so an off-topic prompt usually recalls nothing; the plugin adds no word-matching gate of its own. Engine
  reminders, markup and links are removed from the prompt first. A long strategy is shortened, not passed over.
- **Every reuse is reported twice.** A host's earlier Evolver plugin is enabled too: `evolver-mods` or
  `evolver-agent-plugin` on Claude Code, `evolver@evomap` on Codex, `evolver@evomap-workbuddy` on WorkBuddy,
  `evolver-antigravity-plugin`, `evolver-opencode-plugin`, or the npm `@evomap/dsh-evolver` in a dsh profile. The earlier `evolver-agent-plugin` 0.1.0 on Claude Code
  kept its state in Claude Code's plugin store, which `evolver-plugin` does not read.
- **A reuse report seems lost.** Reports wait in `<host>-reports-outbox.json` until the Proxy accepts them, retried
  at every turn end and session start for 8 days.
- **No draft after verified work.** A session's work turns wait in `<host>-distill-pending.json` until there are
  three of them or one fixed an error, and the last one's last check passed; one turn of routine work is below that
  threshold. `/evolver-status` says how many work turns wait and what the last distillation did: below the threshold
  (and why), declined by the model, rejected by the Proxy (with its reason and the terms it refused), drafted, or
  failed. The last 20 outcomes are kept in `<host>-distill-outcomes.json`. A due distillation runs in the background
  without another event (a hook host's waiting worker is named in `<host>-distill-waiter.json`).
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
say which agent a report came from; a local ledger record's cycle is the host's bare session id, and its `platform`
names the host.

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
| Prompt | `promptSubmitted` | A correction stays with the last turn in the session's range of work, as its `correction` line, then the last turn's reuses are reported again under `:correction`. The commit the turn begins on is read alongside the recall, for a range that starts with it to take its diff from. The turn counter moves on and survives the session's end, so a resumed session never repeats a task id. One strategy, or a Recipe expanded into one, is recalled within what is left of the hook's budget and ends with `Apply them where they fit.` |
| Tool result | `toolFinished`, `beforeEdit`, `takeWaitingStrategy`, `recallWhenStuck` | Notes each call: shell commands with their exit code (a run still going is settled by a later note, or counts as not run), edited paths, each file's hash before its first edit. Where the strategy waits for a tool result, the turn's first one takes it and books it, only while that turn is open; a turn with no tool call never gets it, and it is neither reported nor kept out of later recalls. Where a tool result's context reaches the model (`toolResultContext`, or a `tool-result` host), a failed test, build, lint or type-check recalls again, once per distinct failure and twice a turn at most, with a query built from its output and the turn's edits; a strategy that lands within the tool result's budget is added to that result and booked. |
| Turn end | `turnEnded` | Ends as `answer`, `aborted`, `refusal` or `error`. Every injection of the turn is reported (`applied: used`, tier `L1` when the last check has a known result; tier `none` with `reported_by: agent` when the agent only reported its checks), with the `source` of its checks (`observed` by the host; any other is `reported`, the agent's). A report carries no command, prompt or code. A trial Gene the Proxy withheld from the turn is reported to `POST /asset/trial-control` under the `withheld_id` of that withholding, once per Gene, with whether the turn's last check passed (a withholding without an id is no control). A work turn (it edited files, ran a check, or ran three commands; reading and answering are none) joins the session's range of work turns since its last distillation, with its commands, checks (exit code where the host gives one, the end of a failed one's output) and edits in the order they ran and, in a git work tree, the tree's root, the commit the range began on and the diff from it to the work tree (untracked files included, up to 256 KiB, taken within 1 s), so work committed meanwhile is in it. The diff is replayed as it is, so one that holds a secret or touches a file keys are kept in (`.env`, a private key, a keystore, a credentials file) is left out whole, never redacted in place, with the root and HEAD, so nothing can replay the tree; `diff_omitted` then says why (`secret`, `too_large`, `not_utf8` for bytes that are not UTF-8, `submodule` for a change inside a submodule, which a fresh worktree does not check out, or `unavailable` when git could not give one). The snapshot is the whole work tree, not only the turn's edited files, since its checks ran on all of it and the Proxy reruns them on the same files; it goes only to the loopback Proxy (`proxySettingsFrom` ignores any other URL), which keeps it on this machine to rebuild that tree. It schedules distillation when a range is due, and arms it for when the next one comes due. |
| Session end | `sessionEnded` | Only writes: a turn still open ends, what is unreported goes out as aborted, the session's range is closed for background distillation. |

**State** lives in one directory per host, every file named `<host>-<kind>`. Writes go through an exclusive lock with
dead-owner takeover; hooks only append reports to a queue, and one process at a time owns the outbox.

**Distillation** happens outside the conversation, on a session's range: its work turns since its last distillation
(at most the latest 20). It comes due when the session ends or its owner is gone (`trigger: session_end`), 10
minutes after the range fixed an error and that check has not failed again (`error_episode`), or once the session has
been quiet 30 minutes (`idle`); any prompt or turn end starts a quiet wait again, and a range found due at a prompt
stays due. Every prompt and turn end, besides a session's start and end, starts the background worker when a range is
due, and arms a wake-up for when the next one comes due (its quiet wait or retry delay over), which every background
run arms again, so a session left open needs no further event. A hook host keeps one detached waiter per host and
state folder, `bin/worker.mjs <host> --at=<ms> distill` recorded in `<host>-distill-waiter.json` and replaced only for
an earlier time; a resident plugin or server keeps one timer.

A due range first meets the gate, with no model call: at least three work turns or one closed error episode (a check,
compared without its output trimming or redirects, failed, files were edited, and the same check passed), at least
one check with a known result, and the last work turn's last check passed. Below it, the outcome `below_threshold`
is logged and nothing else happens: a session still open keeps its range and waits for more work, an ended one drops
it. A range that passes is kept, as it would be sent, in `<host>-distill-corpus.json` (the last 200, on this machine
only) for `scripts/distill-calibrate.mjs`, and the host's model gets the `session-gene-ir-v1` prompt: the IR's fields
and rules, a supplement for the record's default kind (`fix` with an error episode, `investigate` with no edits,
`configure` when only configuration, manifest or CI files changed, else `change`), and the record as numbered lines
`R1…Rn` (each turn's prompt, commands, checks with their exit codes and a failed one's redacted output tail of 20
lines and 2 KiB at most, edits relative to the project, answer and correction, then the range's diff, as a file list,
line counts and first hunks when it is over 24 KiB). It answers 0 to 2 IRs, one per unrelated task, or `{"skip": …}`.
Each IR that keeps the IR's shape (fields, counts, `scope.signals` of at most 64 characters, references inside the
record) goes to `POST /conversation/distill` as its own request: `ir_version`, `ir`, the same `record`,
`user_prompt`, `final_answer`, `execution.trace` as `{ command, exit, source }` per check (`ok`, what its output
said, in place of `exit` when the host gives no exit code, which is never made up), `project` (`{ root, head, diff }`
with the range's starting commit as `head`, or only `{ diff_omitted }`), `project_dir`, the trigger and
`reused_asset_ids`: the strategies the session's injection ledger booked into the range's turns (a turn of an
earlier session file with the same number is another turn), `sha256:` ids only, in the order they were injected, at
most 20, left out when there are none or the session's file cannot be read. A Proxy that knows the field keeps it as
the Gene's `generation_meta.reused_asset_ids`, so a Gene names the assets the work it was distilled from reused. The
distiller reads only the body fields it knows, so a Proxy from before the field (2.0.50 and earlier) distills the same
Gene with or without it and the request never fails over it. The record is
fitted to the Proxy's 256 KiB before the model reads it (the diff is left out as `too_large` first, then the diff
lines, then the oldest turns), so the lines an IR cites are the lines sent. The Proxy's answer is `stored`, a draft,
or refused with a typed `quality.reason` and the `terms` it found; every outcome, the model's skip and a failure are
logged with their reason in `<host>-distill-outcomes.json` (the last 20), and the turns read are done with, so they
are never distilled again; turns that joined while the model answered start the next range.

Without a host verifier, which only an isolated Linux Proxy has, the Proxy stores nothing and answers the Gene and
Capsule as a draft; it is kept in `<host>-distill-drafts.json` until the person publishes or discards it with
`evolver-drafts`. Explicit publication of `publishable: false` drafts first calls `POST /asset/reverify` with
`{ assets, persist: false }`, a 120-second budget and the command's cancellation signal. The Proxy's trusted verifier
must authorize it; missing verification keeps the draft local. A successful response's complete bundle and receipt
replace the local draft before `POST /asset/submit`, preserving them for retry. The plugin never configures the
verifier or manufactures receipts; the Proxy validates the authorization. A failed distillation is tried again in the
background after 10 minutes, then 20 (doubling, at most 6 hours), and given up after three failed tries, and a range
no model here can take waits a day for an agent's IRs before it is dropped. A model runner that captures the session's
route and reports it unavailable (`MODEL_UNAVAILABLE`) parks the range without costing a try, out of background
retries, until the route works again or seven days after it was first found blocked. IRs an agent wrote for a range
that changed since (another turn, a correction) are not sent. A correction of a turn a distillation is reading
discards its answer (a Gene the Proxy stored stands) and leaves the range, with the correction, for the next one; a
draft distilled from that turn before the correction is removed, and, marked in `<host>-distill-corrections/`, can
never be published. A headless run carries `EVOLVER_HEADLESS=1`, which turns this plugin's hooks off inside it.
MiniMax strips that variable, so a private marker in the runtime's empty scratch folder suppresses re-entry too. Its
work turns capture provider/model/variant from a read-only projection of native v2 session metadata and check the
hook's model name; an unknown schema or mismatch never selects another provider. The prepared CLI configuration is
private to the run and removed after completion, error or cancellation. An agent with no model outside the
conversation writes the IRs itself when asked, once its session's work passes the gate.

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

**Engine.** When no Proxy of `2.0.50` or newer answers, a session start installs or upgrades `@evomap/evolver` under
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
                       host-neutral pure rules: recall ranking, Recipe expansion, redaction, reuse
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
  recalls nothing. Lengths are in estimated tokens, not characters (a Han character about one, Latin text about four
  characters to one), so a Chinese strategy is not cut four times shorter than an English one: each line keeps 100
  tokens, and a strategy longer than 1000 keeps its first line, its `Safety boundary:` and `If <signal>: <response>`
  lines and as many others as fit, giving up a compiled Gene's `Exact …` contract lines first and its `Do not use
  when` line next, then names how many lines of which asset it left out. A Recipe, likewise, is
  taken only from an answer the Hub judged (below).
- **Recipes.** A Recipe is an ordered chain of strategies. Each prompt is searched for Recipes
  (`POST /recipe/search`, with the same `context` as the text recall) alongside the text recall, both at once, and a
  fitting Recipe comes before a single strategy. Recipe search alone has no relevance floor, and a few shared words
  let chains about unrelated work through (screening 45 SWE-bench Pro tasks, 32 got one), so a Recipe is taken only
  from an answer the Hub judged against the task (`context_fit: {judged, kept}`, evomap-hub#4022), best fit first;
  an unjudged answer, as from a Proxy that drops the context, offers none, and a recall with no task searches none.
  `/evolver-search` judges against the person's own words (`trigger: search`). The best Recipe's steps' assets are
  then fetched by id through `/asset/fetch`, billed per asset as any fetch is, and shown in
  order under one heading each, within 2000 tokens: a step that needs less than an even share keeps all its lines,
  and a longer one is shortened as a single strategy is, rather than the chain being dropped whole. A Recipe missing a
  required step, left with fewer than two, or with a step whose first line does not fit its share is passed over for
  the next one, then for a single strategy; the recall's trace says which (`passed_over`) and how many steps were
  shortened (`shortened`). Each step is booked in the injection
  ledger under its own asset id and its own text, read as a single strategy of the step's name, so every report
  (turn end, correction, retention) and the turn summary go step by step; the Recipe's id is never reported. A
  Recipe whose required steps the session has seen is passed over before its steps are fetched, so an optional
  step the Hub did not return never brings it back.
- **Task context.** Every recall sends `context` beside `text`: an object the Hub defines and the Proxy forwards
  whole, here `{ task, trigger, language? }`. `task` is the session's first typed prompt (4000 characters, cleaned as
  a prompt is, and cut further so the context stays within the Proxy's 4096-byte limit), `trigger` is `turn_start`
  or `check_failed`, and `language` the touched files' languages. The Hub judges each recalled asset's fit to the
  task with it, never recalls by it. The text recall also carries `project_dir`, the session's project directory,
  for the Proxy to recognise the project by, so its local project notes and project-bound Genes can be recalled. A
  prompt's opening is often its boilerplate, and an error line alone names no
  task: an offline replay of 53 SWE runs fired on 15 failed
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
  | Turn end | `<host>:<session>:<turn>` | `tier` `L1` when the last check has a known result, else `none`; `applied: used`; `check` `{kind, passed, fail_then_pass}`; `source` (`observed` or `reported`); `aborted`; `stage: immediate` |
  | Next prompt corrects or approves | `…:correction` | `tier: L3`, `applied`, `stage: correction` |
  | Next session finds the edits kept or reverted | `…:retention` | `tier: L2`, `applied`, `stage: retention` |

  An injected strategy counts as used (dsh #55): the plugin cannot tell from a turn's evidence whether the model
  followed it, and a reused turn is distilled like any other, the engine's intake dropping a Gene it already has.
  `fail_then_pass` compares checks with output trimming (`| tail -9`, `2>&1`) removed, so the same check piped
  differently is still the same check. The outcome follows the last check; with none it follows how the turn ended.
  A finished check with no native exit code is unknown (`failed: null`) unless its output contains failure
  evidence or a supported Node/TAP summary with a positive pass count and zero failed tests. An unknown last
  result keeps the report at tier `none`, keeps the session's work below the distillation gate and claims no saving;
  it never falls back to an earlier passing check. For Codex runs without an exit code, text-only Jest, Vitest,
  pytest, Go and Cargo successes stay unknown unless they emit a supported summary. This can reduce L1 evidence and
  distillation in those projects. An unknown check is a plain command in the distillation record and provides no
  execution trace row; a check whose result is known without an exit code is a check line with no `exit` (and
  `failed: true` when it failed). A native exit code of zero still passes without requiring output.
  A tier `none` report counts as exposure only on the Hub and is not written to the local ledger. Any other report the
  Hub took is also appended to evolver-core's root events, `value.reuse_hit` for a success and `value.reuse_outcome`
  (with its `outcome`) otherwise, with `assetId`, `cycleId` (the host's session id), `platform` (the host),
  `taskId`, `tier` and `stage`, so a reader of the ledger can tell which agent reused what on which evidence.
  evolver-core's event schema leaves the payload open (2.0.50 and every release before it), so a core that reads
  none of the four keeps them and records the event as before.

  The Proxy forwards `evidence` whole, and a Hub that does not know `source` refuses the whole report as
  `validation_error`, which the Proxy passes on as a terminal rejection: on one machine from 5 to 8 November 2026,
  all 175 Claude Code reports a 2.0.49 Proxy relayed with `source` were refused that way. Such a report goes once
  more at once, without `source`; that answer settles it, and the outbox keeps the report as last sent, so a retry
  never carries `source` again.
- **Report outbox.** Reports are keyed by task id and asset, queued once and retried for 8 days, long enough for a
  retention follow-up a week later. A report counts as delivered once the Hub answers it at all: `recorded`,
  `duplicate_report`, or `eligible: false` (`daily_cap`, `same_owner`, `no_delivery_proof`) are final, so only an
  unreachable Proxy or an unrecorded answer is retried. The Hub counts one turn-end report per node, asset and UTC
  day. A request the Hub refuses as invalid can never succeed: the Proxy marks it `terminal: true` (an older one
  says `hub 400` or `hub 422`), and the report is settled as rejected and kept out of the local ledger (a
  `validation_error` of a report with a `source` only once it was refused without it too, above). `hub 404`
  (the Hub may not serve the route yet), `hub 5xx`, 401, 403, 429 and timeouts are retried until the report expires.
- **Turn numbers** come from a per-session counter, one per turn whatever started it, kept past the session's end:
  a resumed session continues under the same id, and a repeated task id is one the Hub drops as a duplicate.
- **Subagents** get no recall; their checks and edits count toward the main turn.
- **Distillation is session-level.** One verified turn was a poor unit: a small edit qualified, and a failure fixed
  over several turns was cut apart. A session's work turns accumulate instead, and distillation runs only when they
  pass the gate, at a session-level moment or once a fixed error has settled, never after each turn. The model reads
  what the work was (the failed check's own output, the diff from where the range began, the person's correction)
  rather than a digest, and answers a structured IR whose rules cite record lines, so the Proxy can check every rule
  against the record and judge project-specific terms by where they came from. A correction no longer drops the work:
  it is what the next distillation most needs to read.
- **Trial controls.** When the Proxy holds a trial Gene back from a turn it would fit, to measure the Gene against
  turns that went without it, that turn's end reports `{ asset_id, task_id, passed, platform }` to
  `POST /asset/trial-control` through the outbox, only when it ran a check with a known result and the Gene did not
  reach it later in the turn; the treated turns are the ordinary reuse reports.
- **Calibration.** `node scripts/distill-calibrate.mjs <state>/<host>-distill-corpus.json [--model "<command>"]
  [--proxy <url>] [--limit <n>]` runs today's gate, prompt and Proxy over the kept corpus (the model command reads
  the prompt on stdin; `claude -p --output-format json` by default), posts every IR with `persist: false`, and prints
  one JSON report: the gate's pass rate and why the rest fell below it, the model's answers, each IR's outcome and
  rejection reason, and per IR its references per rule, failure repairs, unknowns, contracts and project notes. A
  change to the prompt, the gate or a limit is compared on it with the version before.

## Indexed native sessions and isolated ACP completion

Kimi Code's profile uses wire protocol 1.5 for CLI 2.4.1 and Desktop 1.2.1 on Windows.
Both local clients use the same Kimi profile and managed plugin. The profile declares the native workspace/session
layout; `runtime/native-facts` owns bounded filesystem reads and refuses linked, replaced, malformed or partial
records. The driver opens a logical turn before the host admits its native turn. `app/native-turn` binds the two
using the captured byte/file boundary, then closes only the matched main-user terminal. `Stop` is an observer
hint. A detached native monitor catches terminal writes after the last hook; recovery reads those records before
orphan abort reporting. Turn number, session epoch and owner guards keep a late observer with its original turn.
Background checks remain unknown until matching native task metadata settles them. Other hosts retain their
existing transcript/tool-result adapters; Kimi subagents and concurrent prompts are outside this v1 contract.

The optional ModelRunner `capture` port records the selected alias, provider, upstream model, effort and a
credential/config binding before recall returns. The `acp` runner revalidates that binding before creating one
private session and sending one prompt. It uses a private HOME and a selected-only TOML config; the credential is
passed in an environment variable. The private agent has no tools/subagents, project hooks, user plugins or MCP
servers. ACP success, the native/provider terminal, exact route and native process closure must agree. A separate
IPC guardian handles cancellation and owner death before removing owned scratch. On Windows the system
PowerShell helper assigns the native process to a non-inheritable kill-on-close Job Object at creation, with
only its stdio handles inherited. The helper terminates remaining job members and proves the job is empty
after native exit or stop. It reports proof separately from native output. Scratch with no proof is kept;
the job does not contain processes created by an external broker outside the descendant tree.

When a captured route is unavailable or has changed, preflight preserves the candidate for seven days from the
first block. The person can retry after restoring the original binding. A repeat block keeps the original
deadline. A verified turn with a missing or unmatched binding is cleared on the first distill without
calling the model or Proxy. A new verified turn can capture its own binding. Ordinary model and protocol failures
keep the existing retry policy.
The `kimi.com` managed route reads the current access token and device identity from the exact native profile.
It binds both to the snapshot, preserves the native provider family separately from its transport, and passes
only the access token in the private child's environment. It does not manage login or refresh.
Draft publication still uses the shared explicit command and Proxy contract. Other regions, clients and native
acceptance on each target OS are separate gates, not inferred from fixture tests.

The Kimi pack manifest opts in to the pinned `smol-toml` ESM closure and its BSD license. The packer rewrites
Kimi's parser import to a relative path, so installed Kimi bundles load without npm. Source and release packing
install the pinned dependency first.

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
npm run test:kimi
npm run test:minimax
npx -p typescript tsc -p .
npm run validate
```

`tsconfig.json` reads `.claude/types/claude-code.d.ts`; write it with `/plugin-types` after each Claude Code
update. `npm run validate` packs `dist/claude-code` and runs `claude plugin validate` on it, which needs Claude Code
2.1.286 or newer; an older `claude` on `PATH` validates the plugin as having no hooks. Installed copies update by
version: bump `version` in a host's manifest with every change meant to reach its users, or the host reports the old
version as the latest.

PR CI runs the Kimi packed-hook and shared runtime tests on Windows with Node 22 and 26. The suite uses disposable
profiles and local service fixtures. It requires no developer account, Hub token or globally installed Kimi CLI.
Release CI runs the full suite on Linux and the MiniMax/packed-hook/shared-runtime suite on Windows, each
on Node 22 and 26. Both jobs must pass before publication. MiniMax tests use disposable native profiles and
local service fixtures; they do not require a developer's MiniMax account, Hub token or globally installed CLI.
The MiniMax suite runs up to four test files at once; its multi-process contention tests retain their own parallel workers.

## Open questions

- Whether `@evomap/evolver-core`'s terms allow redistributing a plugin that imports it.

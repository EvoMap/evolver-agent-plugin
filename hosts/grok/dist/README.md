# Evolver — Grok plugin

Evolver for the Grok CLI (`grok`), powered by [Evolver](https://github.com/EvoMap/evolver) (`@evomap/evolver`) and
[EvoMap](https://evomap.ai): for each prompt it recalls one proven strategy and hands it to the model at the turn's
first tool result, reports at the turn's end how the turn that used it went (with the checks it ran as evidence),
and distills the session's verified work into a draft Gene when the session ends.

The plugin runs entirely from Grok hooks. It registers **no tools, skills or MCP servers**, so nothing of Evolver
enters the model's context but the recalled steps, which end with `Apply them where they fit.`, and the one
`/evolver-evolve` command.

## Install

```bash
grok plugin marketplace add EvoMap/evolver-agent-plugin
grok plugin install evolver-plugin --trust
```

Then start a new session. `--trust` turns the plugin's hooks on; without it Grok shows what the plugin holds and
stops. `grok inspect` lists it as enabled, with its hooks.

Install it through the marketplace, as above. `grok plugin install EvoMap/evolver-agent-plugin`, a form Grok also
accepts, installs the repository's root instead, which Grok reads through Cursor's manifest there: Cursor's command
files and hooks, which never run on Grok.

### Requirements

- Grok CLI 1.0.70 or newer.
- Node.js 22.13 or newer on the `PATH` Grok hooks see (hooks inherit the environment Grok was started in).
- Evolver 2.0.44 or newer. The plugin installs it under `~/.evolver/state/grok-engine` and starts its Proxy in the
  background when none is running; `npm install -g @evomap/evolver@latest` works too.

Local memory works with no account, key or node id. Connecting to the EvoMap network is optional: run `evolver` once
in a git repository and open the claim link it prints while signed in to [evomap.ai](https://evomap.ai).

## When the strategy reaches the model

Grok discards what a `UserPromptSubmit` hook prints when it lets the prompt through, so a strategy cannot ride the
prompt as it does on other agents. The prompt hook recalls it and keeps it for the turn; the turn's first
`PostToolUse` (or `PostToolUseFailure`) hands it over as `additionalContext`, which Grok puts right after that
tool's result, and only then is it counted as reused. A turn that answers without any tool call never sees it: it is
not reported, and a later prompt may recall it again. Grok names no turn on a tool result, so one that arrives late
from an interrupted turn could carry the next turn's strategy.

## What runs when

| Grok hook | What the plugin does |
| --- | --- |
| `SessionStart` | Reports whether an earlier session's edits in this project were kept, reports a killed session's open strategies as aborted, sets Evolver up and distills leftover candidates, all in a detached background process. Shows a one-off notice when it installed, upgraded or could not start Evolver. |
| `UserPromptSubmit` | Answers the `evolver-*` commands itself. Otherwise recalls a strategy by the prompt text and keeps it for the turn; reads the prompt as a correction or approval of the previous turn's reuse, and a correction drops that turn's candidate. |
| `PreToolUse` (edit tools) | Hashes the file an edit is about to change, for the next session's retention report. |
| `PostToolUse`, `PostToolUseFailure` | Notes the turn's commands with their exit codes, its checks (test, build, lint, type check) and the files it edited; the turn's first one hands over the recalled strategy. A command Grok moves to the background (past its `block_until_ms`, 30 s by default) has no verdict until `get_command_or_subagent_output` returns its exit code in the same turn; until then the check counts as not run. |
| `Stop` | Reports every strategy the turn used, and makes the turn the session's distillation candidate when it ended on a passing check after editing files or running three commands. The `Stop` Grok fires at session end is ignored. |
| `StopFailure`, `StopCancelled` | Report the turn's strategies as failed or aborted. |
| `SessionEnd` | Closes a turn still open, reports what is left as aborted, and distills the session's candidate in the background. Keeps the session's turn counter, so a resumed session never repeats a task id. |

Events inside a subagent (they carry `subagentType`) are not the session's turn: they get no recall and end no turn.
Nor is a turn Grok starts itself when a background task completes (its prompt id is `task-completed-…` and its
prompt only Grok's reminder): it takes no turn number and leaves the last turn's reuses for your next prompt to
correct or approve.

## Commands

Grok plugin commands are prompts for the model, so the plugin's commands are typed into the prompt box as they are,
with or without a leading `/`. The `UserPromptSubmit` hook answers each one and blocks the prompt: Grok sends it to
no model, opens no turn and shows you the answer as the block's reason. The blocked command stays at the front of
Grok's queue, where you edit, resend or discard it. `grok -p` prints no such reason, so in a script run the
commands from a terminal instead (below).

| Typed in Grok | What it does |
| --- | --- |
| `evolver-status` | The Proxy, engine setup, this session's distillation candidate and the drafts waiting. |
| `evolver-search <text>` | Finds the EvoMap strategy that best fits the text. |
| `evolver-login` | Signs you in to the EvoMap Hub: answers a link and a code to approve, then, typed again, the registered node. |
| `evolver-distill [focus]` | Distills this session's latest verified turn into a draft now. |
| `evolver-drafts [publish\|discard <number>]` | Lists the distilled drafts; publishes one to the EvoMap Hub for review, or discards it. |
| `/evolver-evolve [focus]` | An evolution checkpoint for the agent. A prompt hook cannot hand the agent text, so this is the plugin's one command file, which Grok sends to the model; it counts only typed with its `/`. |
| `evolver-sync`, `evolver-review`, `evolver-run`, `evolver-solidify` | Run the `evolver` CLI in the project (`npx -y @evomap/evolver` when it is not installed). |

Only a prompt that is exactly a command counts; `evolver-status` followed by more text is an ordinary prompt. The
prompt box waits while a command runs: up to two minutes for `evolver-distill`, ten for the engine commands.

The same commands run in a terminal, where no session is current, so `evolver-distill` takes the newest candidate.
The marketplace installs the repository's `release` branch, so the plugin is its `dist/grok` folder:

```bash
node ~/.grok/installed-plugins/<folder>/dist/grok/bin/command.mjs grok evolver-status
```

## Session-end distillation

When the session ends, a detached process runs Grok itself headless on your own config —
`grok --prompt-file <folder>/prompt.md --output-format json --verbatim --no-subagents --no-plan --disable-web-search
--max-turns 1` with no tools offered, in an empty folder — to write a Gene from a digest of the candidate turn
(task, commands, paths, checks, final answer; keys and tokens stripped), and sends it to the Proxy's
`POST /conversation/distill`. Unless the Proxy verifies it, the answer is a draft, kept until you publish or discard
it with `evolver-drafts`. A candidate is tried three times, then given up.

The plugin's hooks stay quiet inside that run, and the Claude Code and Cursor hooks, rules, skills and MCP servers
Grok imports are turned off for it (`GROK_CLAUDE_HOOKS_ENABLED=false` and the like), with Grok's turn summary and
memory. Grok still asks its session-title model once. Hooks in `~/.grok/hooks` and other plugins' hooks have no
switch: a blocking `Stop` hook there keeps the run going past `--max-turns`, and such an answer is refused rather
than sent.

## Reuse reports

Every strategy handed to a turn is reported through the Proxy's `POST /asset/reuse-result` with the task id
`grok:<session>:<turn>`; a correction or approval in the next prompt adds a report under `…:correction`, and the
next session in the same project one under `…:retention`. Reports wait in `~/.evolver/state/grok-reports-outbox.json`
and are retried for 8 days.

## Troubleshooting

- **No recall and no reports.** `grok inspect` lists the plugins Grok loaded. A folder of Claude Code's
  `evolver-plugin` placed directly in `~/.claude/plugins/` is loaded by Grok too and, sharing the name, shadows this
  one; its hooks file is a Claude Code hooks module, which Grok cannot run. Claude Code's own marketplace installs
  (under `~/.claude/plugins/cache/`) are not loaded by Grok.
- **The hooks do not run in a project.** Grok holds back plugin hooks until the folder is trusted (`/hooks-trust`, or
  `--trust`); `grok -p` counts the folder as trusted.

## Uninstall

```bash
grok plugin uninstall evolver-plugin
```

Local Evolver memory under `~/.evolver/` is left as it is.

## License

MIT. See [LICENSE](LICENSE).

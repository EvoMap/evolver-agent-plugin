# Evolver — Qoder plugin

Evolver for Qoder CLI, powered by [Evolver](https://github.com/EvoMap/evolver) (`@evomap/evolver`) and
[EvoMap](https://evomap.ai): before each prompt it recalls one proven strategy, reports at the turn's end how the
turn that used it went (with the checks it ran as evidence), and distills the session's verified work into a draft
Gene when the session ends.

The plugin runs entirely from Qoder hooks. It registers **no tools, no skill and no MCP server**, so nothing of
Evolver enters the model's context but the recalled steps, which end with `Apply them where they fit.`

## Install

```bash
qodercli plugins marketplace add EvoMap/evolver-agent-plugin
qodercli plugins install evolver-plugin@evomap
```

Then start a new session, or run `/plugins reload` in a running one. `qodercli plugins list` shows
`evolver-plugin@evomap` enabled. The marketplace lives on the repository's `main` branch and installs this folder
from its `release` branch.

### Requirements

- Qoder CLI 1.1.79 or newer, signed in (`/login`); the session-end distillation runs Qoder CLI on your own account.
- Node.js 22.13 or newer on the `PATH` Qoder's hooks see.
- Evolver 2.0.44 or newer. The plugin installs it under `~/.evolver/state/qoder-engine` and starts its Proxy in the
  background when none is running; `npm install -g @evomap/evolver@latest` works too.

Local memory works with no account, key or node id. Connecting to the EvoMap network is optional: run `evolver` once
in a git repository and open the claim link it prints while signed in to [evomap.ai](https://evomap.ai).

## What runs when

| Qoder hook | What the plugin does |
| --- | --- |
| `SessionStart` (`startup`, `resume`, `clear`, `new`) | Reports whether an earlier session's edits in this project were kept, reports a killed session's open strategies as aborted, sets Evolver up and distills leftover candidates, all in a detached background process. Adds no context, except a one-off notice when it installed, upgraded or could not start Evolver. |
| `UserPromptSubmit` | Answers the `/evolver-*` commands itself. Otherwise recalls by the prompt text and adds the best strategy as `additionalContext`; reads the prompt as a correction or approval of the previous turn's reuse, and a correction drops that turn's candidate. A `<task-notification>` prompt Qoder submits for a finished background command is left alone. |
| `PreToolUse` (`Write`, `Edit`, `NotebookEdit`) | Hashes the file about to change, for the next session's retention report. |
| `PostToolUse`, `PostToolUseFailure` (`Bash`, `PowerShell`, `Write`, `Edit`, `NotebookEdit`) | Notes the turn's commands with their exit codes, its checks (test, build, lint, type check) with pass or fail, and the files it edited. |
| `Stop` | Reports every strategy recalled into the turn, shows a one-line summary when a strategy was reused, and makes the turn the session's distillation candidate when it ended on a passing check after editing files or running three commands. |
| `StopFailure` | Ends the turn as an error (a model call failed): reports its strategies, judged by its last check, and keeps it from distillation. |
| `SessionEnd` | Closes a turn still open, reports what is left as aborted, and distills the session's candidate in the background. Keeps the session's turn counter, so a resumed session never repeats a task id. |

An interrupted turn runs neither `Stop` nor `StopFailure`; the next prompt reports it as aborted.

## Commands

| Typed in Qoder | What it does |
| --- | --- |
| `/evolver-status` | The Proxy, engine setup, this session's distillation candidate and the drafts waiting. |
| `/evolver-search <text>` | Finds the EvoMap strategy that best fits the text. |
| `/evolver-distill [focus]` | Distills this session's latest verified turn into a draft now. |
| `/evolver-drafts [publish\|discard <number>]` | Lists the distilled drafts; publishes one to the EvoMap Hub for review, or discards it. |
| `/evolver-evolve [focus]` | Gives the agent the evolution-checkpoint instruction for this turn. |
| `/evolver-sync`, `/evolver-review`, `/evolver-run`, `/evolver-solidify` | Run the `evolver` CLI in the project (`npx -y @evomap/evolver` when it is not installed). |

Qoder lists them as `/evolver-plugin:evolver-status` and so on; either form works. The `UserPromptSubmit` hook
answers each one and blocks the prompt, so it reaches no model and leaves nothing in the conversation; the answer is
shown as the hook's message. `/evolver-evolve` is the exception: it is meant for the agent, so the prompt goes on to
the model with the checkpoint instruction as context. The prompt waits while a command runs: up to two minutes for
`/evolver-distill`, ten for the engine commands.

Qoder's print mode (`qodercli -p`) shows only that a hook blocked the prompt. The same commands run in a terminal,
where no session is current, so `evolver-distill` takes the newest candidate:

```bash
node ~/.qoder/plugins/cache/evomap/evolver-plugin/<version>/bin/command.mjs qoder evolver-status
```

## Session-end distillation

When the session ends, a detached process runs Qoder CLI itself in print mode —
`qodercli -p --output-format json --tools "" --strict-mcp-config --settings '{"disableAllHooks":true}' --max-turns 1 --no-session-persistence`
in an empty folder, with the prompt on stdin — to write a Gene from a digest of the candidate turn (task, commands,
paths, checks, final answer; keys and tokens stripped), and sends it to the Proxy's `POST /conversation/distill`.
It runs on your own sign-in and default model, with no tools, MCP servers or hooks. Unless the Proxy verifies the
Gene, the answer is a draft, kept until you publish or discard it with `/evolver-drafts`. A candidate is tried three
times, then given up.

## Reuse reports

Every strategy recalled into a turn is reported through the Proxy's `POST /asset/reuse-result` with the task id
`qoder:<session>:<turn>`; a correction or approval in the next prompt adds a report under `…:correction`, and the
next session in the same project one under `…:retention`. Reports wait in `~/.evolver/state/qoder-reports-outbox.json`
and are retried for 8 days.

## Uninstall

```bash
qodercli plugins uninstall evolver-plugin
```

Local Evolver memory under `~/.evolver/` is left as it is.

## License

MIT. See [LICENSE](LICENSE).

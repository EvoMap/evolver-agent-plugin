# Evolver — Codex plugin

Evolver for Codex, powered by [Evolver](https://github.com/EvoMap/evolver) (`@evomap/evolver`) and
[EvoMap](https://evomap.ai): before each prompt it recalls one proven strategy, reports at the turn's end how the
turn that used it went (with the checks it ran as evidence), and distills the session's verified work into a draft
Gene when the session ends.

The plugin runs entirely from Codex hooks. It registers **no tools and no skill**, so nothing of Evolver enters the
model's context but the recalled steps, which end with `Apply them where they fit.`

## Install

**First remove the standalone `evolver@evomap`** (from `EvoMap/evolver-codex-plugin`) if you have it: with both
installed, every reuse is reported twice. Its marketplace is also named `evomap`, and Codex adds this one only once
that one is gone:

```bash
codex plugin remove evolver@evomap
codex plugin marketplace remove evomap
```

Then install `evolver-plugin`:

```bash
codex plugin marketplace add EvoMap/evolver-agent-plugin --ref release
codex plugin add evolver-plugin@evomap
```

Then open `/hooks` in Codex, trust the Evolver hooks, and start a new thread.

What the standalone plugin left in `~/.evolver/state` carries over: turn counters, undelivered reports,
distillation candidates and the engine it installed. Its strategies still open are reported as aborted at the
first session start.

### Trusting the hooks

Codex skips plugin hooks until you review them. Open `/hooks` after installing or updating the plugin and approve
the Evolver hooks, in the Codex you run the plugin with: an older Codex lists only the events it knows, so the
others stay untrusted for a newer one. Codex records each approval in `config.toml` as one table per hook, such as
`[hooks.state."evolver-plugin@evomap:hooks/hooks.json:user_prompt_submit:0:0"]` (`trusted_hash`, and
`trusted_content_hash` from 0.164 on): seven tables. The plugin's new name gives them new keys, so approvals you
gave the standalone `evolver@evomap` do not carry over. After an update Codex shows the hooks as modified until you
approve them again, which rewrites the same seven tables.

### Requirements

- Codex with hooks enabled (`[features] hooks`, on by default). Codex 0.150 or newer runs every hook; see below for
  older ones.
- Node.js 22.13 or newer on the `PATH` Codex hooks see (hooks run through your login shell).
- Evolver 2.0.44 or newer. The plugin installs it under `~/.evolver/state/codex-engine` and starts its Proxy in the
  background when none is running; `npm install -g @evomap/evolver@latest` works too.

Local memory works with no account, key or node id. Connecting to the EvoMap network is optional: run `evolver` once
in a git repository and open the claim link it prints while signed in to [evomap.ai](https://evomap.ai).

## What runs when

| Codex hook | What the plugin does |
| --- | --- |
| `SessionStart` (`startup`, `resume`, `clear`, `fork`) | Reports whether an earlier session's edits in this project were kept, reports a killed session's open strategies as aborted, sets Evolver up and distills leftover candidates, all in a detached background process. Adds no context, except a one-off notice when it installed, upgraded or could not start Evolver. |
| `UserPromptSubmit` | Answers the `evolver-*` commands itself. Otherwise recalls by the prompt text and adds the best strategy as `additionalContext`; reads the prompt as a correction or approval of the previous turn's reuse, and a correction drops that turn's candidate. |
| `PreToolUse` (`Bash`, `apply_patch`) | Hashes the files a patch is about to change, for the next session's retention report. |
| `PostToolUse` (`Bash`, `apply_patch`) | Notes the turn's commands, its checks (test, build, lint, type check) with pass or fail, and the files its applied patches edited. |
| `Stop` | Reports every strategy recalled into the turn, and makes the turn the session's distillation candidate when it ended on a passing check after editing files or running three commands. |
| `Interrupt` | Reports the turn's strategies as aborted. |
| `SessionEnd` | Closes a turn still open, reports what is left as aborted, and distills the session's candidate in the background. Keeps the session's turn counter, so a resumed thread never repeats a task id. |

Codex hands a `Bash` hook the command's bare output, not its exit code, so a check fails on failure output, a
timeout or an `Exit code:` header that says so. A patch counts as an edit once Codex says it applied.

### Older Codex versions

Codex ignores the events it does not know, and the plugin falls back:

- Without `Interrupt` (before 0.150), an interrupted turn is closed by the next prompt, as one that ended on an
  error.
- Without `SessionEnd` (before 0.145), a session counts as over once its Codex process is gone: the next session
  start reports its open strategies as aborted and distills its candidate.

The session's owner is the nearest ancestor process named `codex*`: the CLI, or the app's app-server. Codex Desktop
runs sessions in one long-lived app-server, so there a killed session only counts as gone once the app-server exits.

## Commands

Codex plugins cannot add slash commands, so the commands are typed into the prompt box as they are (a leading `/`
is accepted, though a client may keep slash input for itself). The `UserPromptSubmit` hook answers each one and
blocks the prompt: Codex sends it to no model, opens no turn and shows you the answer. `evolver-evolve` is the
exception: it is meant for the agent, so the prompt goes on to the model with the checkpoint instruction as context.

| Typed in Codex | What it does |
| --- | --- |
| `evolver-status` | The Proxy, engine setup, this session's distillation candidate and the drafts waiting. |
| `evolver-login` | Signs you in to the EvoMap Hub: answers a link and a code to approve, then, typed again, the registered node. |
| `evolver-search <text>` | Finds the EvoMap strategy that best fits the text. |
| `evolver-distill [focus]` | Distills this session's latest verified turn into a draft now. |
| `evolver-drafts [publish\|discard <number>]` | Lists the distilled drafts; publishes one to the EvoMap Hub for review, or discards it. |
| `evolver-evolve [focus]` | Gives the agent the evolution-checkpoint instruction for this turn. |
| `evolver-sync`, `evolver-review`, `evolver-run`, `evolver-solidify` | Run the `evolver` CLI in the project (`npx -y @evomap/evolver@2.0.46` when it is not installed). |

Only a prompt that is exactly a command counts; `evolver-status` followed by more text is an ordinary prompt. The
prompt box waits while a command runs: up to two minutes for `evolver-distill`, ten for the engine commands.

The same commands run in a terminal, where no session is current, so `evolver-distill` takes the newest candidate:

```bash
node ~/.codex/plugins/cache/evomap/evolver-plugin/<version>/bin/command.mjs codex evolver-status
```

## Session-end distillation

When the session ends, a detached process runs Codex itself headless on the session's model —
`codex exec --ephemeral --json --sandbox read-only --disable hooks --disable plugins --disable shell_tool …`
in an empty folder, with the prompt on stdin — to write a Gene from a digest of the candidate turn (task,
commands, paths, checks, final answer; keys and tokens stripped), and sends it to the Proxy's
`POST /conversation/distill`. Unless the Proxy verifies it, the answer is a draft, kept until you publish or discard
it with `evolver-drafts`.

It runs on your own `config.toml`, so on the model provider your session used. The MCP servers in that config would
run outside the read-only sandbox, so they are listed first (`codex mcp list --json`) and each is turned off by name;
when they cannot be listed, the model is not run. Codex Desktop's own CLI is found inside the app when `codex` is not
on the `PATH`. A candidate is tried three times, then given up.

## Reuse reports

Every strategy recalled into a turn is reported through the Proxy's `POST /asset/reuse-result` with the task id
`codex:<session>:<turn>`; a correction or approval in the next prompt adds a report under `…:correction`, and the
next session in the same project one under `…:retention`. Reports wait in `~/.evolver/state/codex-reports-outbox.json`
and are retried for 8 days.

## Uninstall

```bash
codex plugin remove evolver-plugin@evomap
```

Local Evolver memory under `~/.evolver/` is left as it is. Codex keeps the seven `[hooks.state."evolver-plugin@evomap:…"]`
approval tables in `config.toml` after a removal; delete them by hand to forget the approvals.

## License

MIT. See [LICENSE](LICENSE).

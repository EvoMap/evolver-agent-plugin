# Evolver for DeepSeek Harness

Evolver for DeepSeek Harness (dsh), powered by [Evolver](https://github.com/EvoMap/evolver) (`@evomap/evolver`) and
[EvoMap](https://evomap.ai): before each prompt it recalls one proven strategy, reports at the turn's end how the
turn that used it went (with the checks it ran as evidence), and distills the session's verified work into a draft
Gene after the session ends, through the session's own model.

The plugin runs inside dsh's process, on its plugin events. It registers **no tools and no skill**, so nothing of
Evolver enters the model's context but the recalled steps, which end with `Apply them where they fit.` dsh shows it
as `evolver-plugin`; the package keeps the name `@evomap/dsh-evolver`.

## Install

This package replaces the standalone `@evomap/dsh-evolver` (from `EvoMap/evolver-dsh-plugin`), under the same name.
**Remove that first** in every profile that has it: pnpm may keep an installed package's source when you add another,
and with both loaded every reuse is reported twice.

The package is not on npm yet. Install the packed folder from the `release` branch of `EvoMap/evolver-agent-plugin`
(or a local `npm run pack`), by its absolute path, into each profile you use (`dst` runs `dsh-tui`):

```bash
git clone --depth 1 --branch release https://github.com/EvoMap/evolver-agent-plugin.git
dsh plugin --profile dsh-tui remove @evomap/dsh-evolver
dsh plugin --profile dsh-tui add -w "$PWD/evolver-agent-plugin/dist/dsh"
```

Repeat the last two lines with `--profile web` and `--profile headless`, then restart dsh. dsh links the folder, so
keep the clone: `git pull` in it updates the plugin at the next start.

**DSH Desktop** owns its `desktop` profile, so run its bundled CLI with its own pnpm, as for the standalone plugin.
On macOS:

```bash
APP="/Applications/DSH Desktop.app/Contents"
SHIM=$(mktemp -d)
printf '#!/bin/sh\nexec node "%s/Resources/app/node_modules/pnpm/bin/pnpm.cjs" --config.minimumReleaseAge=0 "$@"\n' "$APP" > "$SHIM/pnpm"
chmod +x "$SHIM/pnpm"
desktop() { PATH="$SHIM:$PATH" CI=true ELECTRON_RUN_AS_NODE=1 "$APP/MacOS/DSH Desktop" "$APP/Resources/app/lib/desktop-cli.js" plugin --profile desktop "$@" </dev/null; }
desktop remove @evomap/dsh-evolver
desktop add -w "$PWD/evolver-agent-plugin/dist/dsh"
```

On Windows, run `dsh plugin remove @evomap/dsh-evolver` and `dsh plugin add -w <clone>\dist\dsh` in the terminal
inside DSH Desktop. Its plugin market installs from npm, which still serves the standalone plugin.

What the standalone plugin left in `~/.evolver/state` carries over at the first session start: undelivered reports,
retention checks, its distillation candidate, and its open strategies, which are reported as aborted.

### Requirements

- dsh 0.1.5 or newer (verified on 0.2.0-rc.2), Node.js 22.13 or newer.
- Evolver 2.0.44 or newer. The plugin installs it under `~/.evolver/state/dsh-engine` and starts its Proxy in the
  background when none is running; `npm install -g @evomap/evolver@latest` works too.

Local memory works with no account, key or node id. Connecting to the EvoMap network is optional: run `evolver` once
in a git repository and open the claim link it prints while signed in to [evomap.ai](https://evomap.ai).

## Options

Set them on the plugin's entry, `evolver`, in a profile's `cordis.patch.yml` (`~/.dsh/profiles/<profile>/`):

```yaml
- id: evolver
  config:
    proxyPort: 19820
```

| Option | Default | Purpose |
| --- | --- | --- |
| `proxyPort` | `$EVOMAP_PROXY_PORT`, then `19820` | The Proxy port used when `~/.evolver/settings.json` names no URL. |
| `assetPrimeEnabled` | `true` | `false` turns recall off. |
| `skillEnabled` | `false` | Accepted and not used yet: the `capability-evolver` skill is not shipped, so nothing of Evolver joins the model's context but recalled steps. |

A wrong value stops the plugin from loading, and dsh says which. The standalone plugin's other options (`projectDir`,
`editToolNames`, the recall's similarity, wait and timeouts, `claimNudgeEnabled`) are ignored: they are the same on
every host now.

## Commands

Type them in the dsh TUI, web app or DSH Desktop. Each runs in the plugin and answers in dsh's UI, never through the
model.

| Command | What it does |
| --- | --- |
| `/evolver-status` | Proxy state, engine setup, Hub sign-in, the session's distillation candidate and waiting drafts |
| `/evolver-login` | Signs you in to the EvoMap Hub: a link and a code to approve, then, run again, the registered node |
| `/evolver-search <text>` | Recalls the best strategy for the text and hands it to the conversation's next step; its reuse is reported |
| `/evolver-distill [focus]` | Distills the session's latest verified turn into a draft now |
| `/evolver-drafts [publish\|discard <n>]` | Lists drafts; `publish <n>` submits one to the EvoMap Hub for review, `discard <n>` drops it |
| `/evolver-evolve [focus]` | Hands the agent a reflection checkpoint, as a follow-up turn of its own |
| `/evolver-sync`, `/evolver-review`, `/evolver-run`, `/evolver-solidify` | Run `evolver <command>` in the project |

## How it works

| dsh event | What the plugin does |
| --- | --- |
| `agent/created` (`agent/session-start` before dsh 0.2) | Reports whether an earlier session's edits in this project were kept, reports a killed dsh process's open strategies as aborted, sets Evolver up and distills leftover candidates in the background. A one-off notice when it installed, upgraded or could not start Evolver joins the next step. |
| `agent/pre-step`, a turn's first step | Recalls one strategy for the person's prompt (up to 6 s) and appends it to the step's messages, behind the prompt. A slower recall joins the turn's next step. A turn no person's message opened (a goal round, a scheduled run) is left alone. |
| `tools/execute` | Notes each call that was allowed to run: `bash` and `pwsh` with their exit code, files `write`, `edit` and `str_replace_editor` change (hashed before the change), files read. A run still in the background has no verdict. |
| `session/event` `turn/end` | Reports every strategy of the turn, judged by its last test, build, lint or type check, else by how it ended (`completed`, `aborted`, `error`, …). A turn that completed on a passing check and edited files or ran three commands becomes the session's candidate. |
| `session/disposed`, or the plugin's unload | Ends the session: an open turn is reported as aborted, and the candidate is distilled with one call to the session's model through dsh's model service, outside the conversation, at once or at the next session start. |

The next prompt is read as feedback: a correction drops the candidate and reports the last turn's strategies again
as failed. A subagent's session is neither recalled for nor recorded. State lives in `~/.evolver/state/dsh-*`.

MIT © EvoMap.

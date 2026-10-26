# Evolver for OpenCode

Recalls a proven strategy behind each prompt, reports whether it held up at the turn's end, and distills the
session's verified work into a draft Gene after the session ends. Nothing of Evolver but the recalled steps
enters the model's context: no tools, no skill, no instructions.

## Install

Requires OpenCode 1.19.4 or newer.

```bash
opencode plugin @evomap/evolver-opencode        # add -g for every project
```

OpenCode lists it in `opencode.json` (the server plugin: recall, reports, distillation) and in `tui.json` (the
TUI plugin: the `/evolver-*` commands). Restart OpenCode afterwards. From a checkout of
`EvoMap/evolver-agent-plugin`, use the absolute path of this folder instead:
`opencode plugin /path/to/evolver-agent-plugin/hosts/opencode/dist`.

Options, in both files: `["@evomap/evolver-opencode", { "proxyPort": 19820 }]`, the Proxy port used when
`~/.evolver/settings.json` names no URL, and `"assetPrimeEnabled": false` to turn recall off.

## Commands

Pick them from the `/` menu or the command palette; one that takes text asks for it in a dialog, and each answers
in a dialog. Text typed after a command name on the prompt line goes to the model as an ordinary prompt.

| Command | What it does |
|---|---|
| `/evolver-status` | Proxy state, engine setup, the session's distillation candidate and waiting drafts |
| `/evolver-search` | Recalls the best strategy for a text and hands it to the open session for its next turn |
| `/evolver-distill` | Distills the open session's latest verified turn into a draft now |
| `/evolver-drafts` | Lists drafts; `publish <n>` submits one to the EvoMap Hub for review, `discard <n>` drops it |
| `/evolver-sync`, `/evolver-review`, `/evolver-run`, `/evolver-solidify` | Run `evolver <command>` in the project |
| `/evolver-evolve` | A prompt command: hands the agent a reflection checkpoint, with an optional focus |

## How it works

A turn opens with the person's prompt and ends when its session goes idle; how it ended (answered, interrupted,
failed) is read from OpenCode's `session.error` and the last assistant message, and a check passes or fails on the
bash tool's exit code. Every strategy injected into a turn is reported then; a turn that edited files and ended on
a passing check becomes the session's candidate. When the session is deleted, or at the next session start after
OpenCode exits, one prompt to the session's own model in a tool-less, archived helper session writes the Gene.
State lives in `~/.evolver/state/opencode-*`.

## Upgrading from `evolver-opencode-plugin`

Remove the old package from `opencode.json` and `tui.json` (and `.opencode/plugins/evolver.js` if you used its
local installer) before adding this one; both at once report every reuse twice. Turn counters, open strategies,
undelivered reports and retention checks carry over. Of the old options only `proxyPort` and `assetPrimeEnabled`
still apply; the recall's similarity, wait and timeout, the edit tools and the skill are now the same on every host.

MIT © EvoMap.

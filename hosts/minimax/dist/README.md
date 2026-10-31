# Evolver for MiniMax Code

Local plugin for MiniMax Code CLI 0.7.4 and Desktop 3.1.6. Requires Node.js 22.13 or newer,
compatible with MCode, and `node` and `mcode` on PATH. Sign in to MiniMax or configure a provider
through MiniMax itself before using distillation. Credentials belong in the native account configuration.

The checkout's `.minimax-plugin/plugin.json` points to `hosts/minimax/dist/hooks/hooks.json`.
Packing uses the same manifest and rewrites that hook path to `hooks/hooks.json` in the installed folder.

From a checkout, install the local plugin:

```text
node scripts/install-minimax.mjs install --dry-run
node scripts/install-minimax.mjs install
mcode plugin enable evolver-plugin@local --json
```

The installer stages the package before replacing its previous installation and restores it if activation
fails. Account configuration, preferences and drafts live outside the package and survive updates. Existing
unmanaged folders and linked plugin paths are refused. To update between tasks, obtain the desired source
revision, then:

```text
node scripts/install-minimax.mjs update
mcode plugin enable evolver-plugin@local --json
```

Start a new task after installation or update. A release checkout uses its ready-made `dist/minimax` package,
preserving its version and contents. Without that folder, the installer builds from the source manifest.
`--version X.Y.Z` explicitly builds the current sources at that version, even when a packed folder exists.
The installer and native package need no `npm ci`; development tests and the generic MCP server do.
`status` reports the installed package; `--data-dir PATH` selects a separate native profile. Package status
does not imply the native host has enabled it. For a prebuilt ZIP, extract its contents directly into
`<MiniMax data>/plugins/evolver-plugin`, with `.minimax-plugin/plugin.json` directly inside that folder.
Enable it with `mcode plugin enable evolver-plugin@local --json`, then start a new task.
`--data-dir` configures the installer only; set `MINIMAX_DATA_DIR` to that same directory for subsequent `mcode` commands.

The data root is `MINIMAX_DATA_DIR`, then `MAVIS_DATA_DIR`, otherwise `~/.minimax`.
Do not install two copies of Evolver for the same host.

To pause this integration, run `mcode plugin disable evolver-plugin@local --json` and start a new task.
To uninstall the package, run `mcode plugin remove evolver-plugin@local --json`. Keep the native plugin-data
folder if you want to retain preferences and unpublished drafts; removal is not a request to delete those files.

Evolver uses the person's existing loopback Proxy and Hub account. `evolver-status` reports connection
problems; `evolver-login` starts the native device sign-in and shows its link/code through the command job.
Approve that sign-in yourself. No account, token, local Proxy URL or developer machine path is bundled.

## Commands and preferences

Type these as ordinary text in the task chat. The hook also accepts a leading slash when the host forwards it:

```text
evolver-status
evolver-status recall off
evolver-status auto-distill off
evolver-drafts
evolver-evolve retry handling
evolver-search transient Redis connection failures
evolver-status jobs
evolver-status job <id>
evolver-status cancel <id>
```

Status and draft listings are shown to the person without opening a model turn. `evolver-evolve` adds the
checkpoint to the agent's turn. Recall and auto-distill preferences persist across sessions; replace `off`
with `on` to enable them again. They live in `<PLUGIN_DATA>/minimax-settings.json`:

```json
{"recall": true, "autoDistill": true}
```

Chat interception blocks the model request. In `mcode exec`, handled status/list commands therefore return
the native rejected-prompt exit code 4 with their result as the reason. For terminal automation, run
`bin/command.mjs` directly instead of wrapping a chat command in `mcode exec`.

Invalid or unreadable preferences pause both automatic activities and are reported by status. Repair the file
before changing settings. In environments which retain them, explicit `EVOLVER_RECALL` and
`EVOLVER_AUTO_DISTILL` values override the file; MiniMax native hooks strip these inherited variables.

MiniMax command hooks have a ten-second budget. Login, search, distill, publishing/discarding drafts and
engine commands (`sync`, `review`, `run`, `solidify`) therefore run in a detached command worker. The chat
immediately shows its job id. Use `evolver-status job <id>` for the result, `evolver-status jobs` for recent
jobs, or `evolver-status cancel <id>` to request cancellation. Results remain user-only; a searched strategy is
not recorded as reused unless it is subsequently recalled into an agent turn.

One command runs at a time per profile, on the session and workspace captured when it was requested. The history
retains up to twenty jobs within 512 KiB, with results capped at 16,000 characters each. A job has a twelve-minute execution
budget; existing command, network and model deadlines remain in force. Cancellation stops the worker's active
request/process tree, while completed side effects and a device sign-in already launched remain in place.
A worker that exits without a result is shown as interrupted and is never automatically replayed. Inspect its
operation before retrying, especially publication. Invalid command state is reported rather than reset.
Turning auto-distill off leaves explicit distill available. Direct terminal commands remain supported below.

## Lifecycle and model selection

The prompt hook recalls strategies, native tool results supply check evidence, and completed verified turns
become draft candidates. A session-end hook schedules distillation. If the host exits without SessionEnd,
the next session start recovers the dead owner's pending work. A read-only native turn-status monitor closes
failed and aborted turns without waiting for another prompt; neither can produce a verified candidate.

Distillation runs `mcode exec` on the verified turn's captured provider/model/variant. The hook supplies only
a model name; a read-only projection of the native v2 session metadata supplies its route. The adapter reads
only those model fields, checks them against the hook, and stores the route with the candidate. Later default
or session-model changes do not replace it. Missing, incompatible or mismatched metadata prevents a completion
from starting. Candidates from older versions which recorded `native-default` retain their former behavior.
A private temporary YAML merge preserves native credentials and overrides capabilities; lightweight mode exposes no tools.
The inherited environment marker and a private scratch-folder marker prevent this plugin from running again
inside its own distillation. The adapter never writes the source configuration; the temporary copy is removed on
completion, failure or cancellation. The native CLI may perform its own first-run configuration migrations, as it
does without this adapter. Other installed plugins remain subject to MiniMax's own hook policy.

MiniMax emits normal Stop only after successful completion. The monitor reads only the matching session/turn
status from the v2 metadata every 500 ms and acts only on `failed` or `aborted`. A completed row does not verify
work; Stop and actual tool evidence still decide that. Monitoring ends when the turn closes or changes, its
owner dies, or after twenty-four hours. A missing/incompatible row is watched for at most thirty seconds.
With missing metadata or an unsupported runtime, the next prompt still closes an unfinished turn as an error;
session-end and dead-owner recovery remain available. No native event or successful check is fabricated.
A normal Stop may show the shared one-line turn summary through the host's user-only `systemMessage`.

State is stored in MiniMax's writable `PLUGIN_DATA` directory, not in the immutable package cache.
Terminal commands use the same v2 state folder. Set `EVOLVER_SESSION_ID` to target a particular session:

```text
node <installed-plugin>/bin/command.mjs minimax evolver-status
node <installed-plugin>/bin/command.mjs minimax evolver-distill
node <installed-plugin>/bin/command.mjs minimax evolver-drafts
```

Set the same `MINIMAX_DATA_DIR` when using a separate native profile. Commands outside a session act on the
latest candidate. Nothing is published until the person explicitly publishes a draft.

This package uses native hooks for local installation. MiniMax's public third-party Marketplace intake currently
excludes Hook JSON and the hooks manifest field; local runtime compatibility does not imply Marketplace eligibility.
The v2 data layout is checked before invoking a model; an unknown layout fails without switching accounts.

## Development checks

`npm test` runs the full repository suite on Linux. `npm run test:minimax` covers this adapter, its packed
hooks and shared runtime on Windows and Linux, using temporary profiles and local test services. It needs no
MiniMax login, Hub credentials, globally installed Evolver, or personal configuration. Release CI requires both
the full Linux suite and the Windows MiniMax/runtime suite on Node 22 and 26, followed by packing.

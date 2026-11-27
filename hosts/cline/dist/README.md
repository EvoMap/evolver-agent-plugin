# Evolver for Cline CLI

This local adapter targets Cline CLI 3.0.73 on Windows. It uses Cline's native plugin loader.
From the Evolver plugin checkout, pack and install for a Cline workspace:

```powershell
node scripts/pack.mjs cline dist/cline
cline plugin install (Resolve-Path dist/cline).Path --cwd "C:\path\to\workspace"
```

Start a new Cline session in that workspace. To update, rebuild the same bundle and repeat
the install with `--force`. To remove it, run `cline plugin uninstall evolver-plugin --cwd "C:\path\to\workspace"`.
Evolver state lives in `<Cline data directory>/evolver-plugin`, outside the installed package. The data
directory defaults to `$CLINE_DIR/data` or `~/.cline/data`. For a separate profile, set `CLINE_DATA_DIR`
to an absolute path before starting Cline. Use that same path in `--data-dir` if you also pass the flag.

The adapter adds the selected Recipe to the current turn's model requests. It verifies a
single foreground command per native `run_commands` call by matching the command and its tool call ID.
Reuse reporting and candidate creation require Cline's terminal confirmation for that turn.
Ctrl-C after a passing check still suppresses both when Cline aborts the turn.

## Private distillation

Use an isolated Cline profile already configured with a saved OpenAI-compatible API key, endpoint, and model.
For this version of Cline, start the TUI with that profile's provider settings held open read-only. Cline's startup
otherwise rewrites the settings file, and the plugin cannot distinguish its active key from a later file change.
Run the following in a separate PowerShell for the intended profile and workspace:

```powershell
$env:CLINE_SESSION_BACKEND_MODE = 'local'
$env:CLINE_PROVIDER_SETTINGS_PATH = 'C:\path\to\isolated\settings\providers.json'
$settingsLock = [IO.File]::Open($env:CLINE_PROVIDER_SETTINGS_PATH, 'Open', 'Read', 'Read')
try { cline --tui } finally { $settingsLock.Dispose() }
```

The provider selection must already be saved in the file. Cline may print a warning when it tries to resave
the locked selection. Start with `--tui` or `-i`. The supported options are workspace/config/data-directory
paths, auto-approval and an optional initial prompt. API-key, provider and model launch overrides, OAuth,
mode-specific routes, custom headers and resumed launches are outside this distillation path.
For a different route, close Cline, update the isolated profile, and start a new verified session.

After a completed turn with a passing check, run `/evolver-distill` and then `/evolver-drafts` to see the
local draft. Distillation sends one isolated completion request using the verified turn's provider, endpoint,
model and API key. The Proxy request has `persist:false` and `publish:false`. The Gene and Capsule are saved
locally as a draft. If Cline cannot prove the route for this live session, the candidate is retained.

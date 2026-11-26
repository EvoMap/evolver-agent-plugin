# Evolver for GitHub Copilot CLI

This adapter targets interactive GitHub Copilot CLI 1.0.112 on Windows. Copilot supplies the extension SDK when
experimental extensions are enabled. Use a separate profile for a local trial.

```powershell
npm ci
$env:COPILOT_HOME = Join-Path $env:TEMP ('ev-cp-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$bundle = Join-Path $env:COPILOT_HOME 'extensions/evolver'
node scripts/pack.mjs copilot $bundle
copilot --experimental
```

Copilot loads `extension.mjs` from the profile's extension directory. The generic plugin installer did not load
this SDK entry in trials with 1.0.112. Use the same profile setting for Evolver's terminal commands. To stop
loading this bundle, select a different profile or remove this extension's bundle directory. Evolver keeps its
preferences, verified work and drafts in `$COPILOT_HOME/evolver`, outside the bundle. Removing the bundle
leaves that state available.

On first use, Copilot asks whether Evolver can register hooks. Review the request and allow hook registration
to enable recall and verification.

Run a foreground test, build, lint or type check in a separate native shell call. The adapter pairs native
shell events and reads their structured exit codes. The executed shell tool and command must match the model's
original request; turns whose commands were rewritten by pre-tool hooks are not verified. It waits for the live SDK `session.idle` event
before reporting verified work. Ctrl-C after a passing check, including while work requested by a competing Stop
hook runs, leaves no reuse report or candidate for the cancelled interaction.

Storage failures are reported on stderr. Pending turn evidence is retried while the extension remains alive;
a forced exit before storage recovers can leave work unsaved and require a fresh verification run.

The model can receive a recalled Recipe in the transformed prompt. Copilot stores this transformed content in
its session history. To opt out of recall, set `EVOLVER_RECALL=off` before starting Copilot.

## Review and distill work

```powershell
$env:EVOLVER_SESSION_ID = '<Copilot session ID>'
node "$bundle/bin/command.mjs" copilot evolver-status
node "$bundle/bin/command.mjs" copilot evolver-distill
node "$bundle/bin/command.mjs" copilot evolver-drafts
```

Set `EVOLVER_SESSION_ID` to the native session ID shown by Copilot. Keep it set when handing the model's
reply back to Evolver.

Automatic model completion is disabled in this adapter. To make a draft, run `evolver-distill` from a terminal.
Give its printed prompt to Copilot and save the JSON response to a file. Pass that file and the printed range
reference back to Evolver, then use `evolver-drafts` to review the result.

```powershell
$rangeReference = '<printed range reference>'
Get-Content -Raw ./gene.json | node "$bundle/bin/command.mjs" copilot evolver-distill --post $rangeReference
```

Set `$rangeReference` to the value printed by `evolver-distill`. The reference binds the answer to the
exact verified range. Drafts remain private until you explicitly publish one. If the Proxy returns `stored`,
it kept the result locally and no item is added to the plugin draft list.

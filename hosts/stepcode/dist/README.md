# Evolver for Step Code CLI

This adapter targets Step Code CLI 0.1.7 on Windows. It is a native extension, loaded through Step's `pi.extensions` package manifest.

```powershell
npm ci
node scripts/pack.mjs stepcode dist/stepcode
step install ./dist/stepcode
```

Start a new session after installation or update. For a disposable profile, set `STEP_CODING_AGENT_DIR` to an absolute directory before starting Step. Evolver keeps its preferences, reports, session ranges and private drafts in that directory's `evolver-plugin` folder.

Recipe guidance is projected into the current prompt's model requests, without being appended to the native transcript. Native `run_command` or `bash` results supply verification evidence. Publication remains an explicit `/evolver-drafts publish <number>` action; ordinary verified work only creates private draft candidates.

Use a separate foreground `run_command` or `bash` call for verification. Inline `then_run` checks and background executions are not supported by this draft adapter; a turn using them is excluded from reuse reporting and candidates. A cancelled turn, including cancellation after a passing check, produces neither a reuse report nor a candidate.

Background completion uses the captured native provider, model, thinking level and account. If that route cannot be verified, the candidate waits rather than switching to the current account. It does not run another agent, load tools, or publish assets.

The `/evolver-*` commands expose status, configuration, draft review and explicit publication in the interactive CLI. This draft does not add a Step Code Desktop adapter.

`/evolver-config recall off` and `/evolver-config auto-distill off` save preferences for this Step profile. Environment overrides still take precedence. To remove the extension, run `step remove ./dist/stepcode` with the same installed source path; this does not delete Evolver's profile data.

## Draft acceptance limits

The native Step Code 0.1.7 Windows package has been exercised with a loopback model and Proxy for Recipe context, passing and failing checks, private drafts, and cancellation. Paid-provider and real Hub acceptance are still pending.

Esc and RPC abort stopped the fixture process in native tests. Double Ctrl-C can make Step exit without a terminal tool event while leaving its tool's shell/process alive. The adapter suppresses reports and candidates for that incomplete turn; it does not terminate processes owned by Step. This native runtime cleanup gate remains open.

SDK completion receives a cancellation signal and rejects late answers. Native credential resolution has no abort-signal interface; interruption of OAuth refresh and transport cleanup against a paid provider have not been verified.

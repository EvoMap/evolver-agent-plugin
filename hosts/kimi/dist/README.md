# Evolver for Kimi Code

The same package integrates Kimi Code CLI 2.4.1 and Desktop 1.2.1 on Windows.
Keep the Kimi Code CLI installed for isolated ACP draft creation. Node.js 22.13+
must be available as `node` on the hook process PATH.

The integration covers the main agent in local sessions with a resolved
API/BYOK provider. The adapter can also resolve the managed Kimi Code account on `kimi.com`. The
managed route uses an existing, fresh access token and the device identity from
the same native profile. Kimi handles sign-in and refresh. Other OAuth regions,
VS Code/web, remote sessions, parallel prompts and subagents require
separate acceptance.

The prompt hook adds recalled context. Tool hooks observe evidence; they do not add
failed-check recall mid-turn. Stop is a lifecycle hint, not proof that a turn has
completed. Native wire/task records supply terminal and verification evidence.

## Local installation

From the repository checkout or an extracted release containing this installer:

```text
node scripts/install-kimi.mjs install
node scripts/install-kimi.mjs status
node scripts/install-kimi.mjs update
node scripts/install-kimi.mjs remove
```

`--home PATH` selects the native Kimi profile root; otherwise the installer uses
`KIMI_CODE_HOME`, then `~/.kimi-code`. Set `KIMI_CODE_HOME` to the same root when
starting Kimi, using an absolute path. Relative roots have not passed acceptance;
native plugin hooks run from the package root rather than the startup directory.
Close Kimi before changing its local plugin registrations, then start
a new session to load the package. Do not install a second copy of Evolver under a
different plugin id or retain a manual duplicate hook registration.

The managed package lives at `<Kimi home>/plugins/managed/evolver-plugin`. The
installer preserves other plugin registrations, native config, credentials and
Evolver state. Removal unregisters this package while retaining its managed bytes,
matching native local-plugin removal; it does not delete preferences or drafts.
The default install/update preserves a bundled `dist/kimi` release and its version.
An explicit `--version X.Y.Z` packs the checkout at that version instead.
Packing source requires `npm ci` in that checkout; installing an existing release
bundle does not download dependencies or change the native account configuration.
The native manifest/registry contract is pinned to Kimi Code 2.4.1 and should be
retested when upgrading Kimi. This direct installation says nothing about
Marketplace eligibility or support by an external Evolver CLI installer.

## Terminal commands

Run from the project directory, using the installed package's absolute entry path.
In Desktop you can run these commands in its terminal. Use `evolver-distill` to
create a draft while the Desktop session remains open.

```text
node <Kimi-home>/plugins/managed/evolver-plugin/bin/command.mjs kimi evolver-status
node <Kimi-home>/plugins/managed/evolver-plugin/bin/command.mjs kimi evolver-drafts
node <Kimi-home>/plugins/managed/evolver-plugin/bin/command.mjs kimi evolver-distill
```

The shared command catalog provides search, login, draft publication/discard and
preferences too. Commands run directly in the terminal; chat command interception
is not part of this host's v1 contract. Publishing a draft remains an explicit user
operation. Kimi's provider account and Evolver's Proxy/Hub account are separate.

Private distillation profiles exclude user/project hooks, plugins, MCP servers and
skills. The selected credential goes to the native process through its environment.
For `kimi.com` OAuth, the private profile contains the selected provider, model and
device ID; it has no OAuth token file or refresh credential. Expired or changed
credentials keep the candidate blocked. A new verified turn can capture a fresh
binding after Kimi has renewed its access token.

On Windows, ACP completion uses a Job Object with kill-on-close. It starts the
native CLI inside the job and waits for the job to empty before deleting scratch,
including when a descendant outlives the native root. This needs Windows 10 or
later and the system Windows PowerShell to compile the bundled Win32 helper.
When proof of an empty job is lost, scratch is retained. The job contains ordinary
process descendants; it is not a sandbox for processes started by an external broker.

## Validation scope

`npm run test:kimi` covers source fixtures, packed hooks with a loopback fake Proxy,
installer rollback and route/isolation checks. CI runs those source tests on Windows
Node 22/26 and the full suite on Linux Node 22/26. They use no real credentials or
model, Proxy or Hub service. The Windows native packed main-CLI flow passed with a
loopback dummy provider/Proxy: recalled context reached the real model request,
native edits/checks produced one candidate/reuse report, the owner matched Kimi and
workers exited. Loopback results do not establish real provider entitlement.
Windows Desktop packed acceptance used the native app with a loopback provider and
Proxy. It verified Recipe injection, a passing Bash check, and one private draft
through the installed CLI's isolated ACP completion. macOS, real Desktop provider
acceptance, and other clients are separate gates.

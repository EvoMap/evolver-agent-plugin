# Hosts

One folder per agent host. A folder holds only where that host differs from its channel's defaults, as an
`AgentProfile` (`profile.js`, see `lib/agent/profile.js`) with small pure readers beside it, plus `dist/`: the
files the host installs and, for an in-process host, its entry modules. A profile never starts a process, takes a
lock or reads a file: what has to run is declared, and `lib/runtime/` runs it. `test/architecture.test.js` checks
that readers import only path, URL and home-folder helpers of Node, and that `dist/` reaches the plugin only through
a channel.

## Difference points

| Point | Field | Default (hook channel) |
|---|---|---|
| Channel | `channel: 'hook' \| 'plugin' \| 'mcp'` | `hook` |
| Events | `events: { hostEvent: canonicalEvent }`, onto `sessionStart`, `prompt`, `toolResult`, `beforeEdit`, `turnEnd`, `sessionEnd`, `command`, `agentGene` | — (MCP: its six tools) |
| Payload | `payload: { sessionId, turnId, prompt, projectDir, isIgnored, model, transcriptPath, gene, writtenFor }`, each `(payload, context)`; `context` has `env`, `transcriptSize()`, `transcriptSince(offset)`, and `turnStart` at a turn's end. `isIgnored` skips a subagent's event or any other that is no turn of the person's | Claude Code's field names |
| Session start | `sessionStart: 'event' \| 'owner-change' \| 'connection'` | `event` |
| Answer | `reply: { context, notice, empty, command, turnEnd, lifetime: 'turn' \| 'call' }`, each `(value, hostEvent, payload)`; `lifetime: 'call'` replays the turn's strategy before every model call | `hookSpecificOutput.additionalContext`, `{}` |
| Evidence | `evidence: { toolNote, editedFile \| editedFiles, turnStart?, turnRecord?, source }`: tool notes as hooks see them, or a turn record read from the host's transcript | required |
| Turn end | `turnEnd: { reason → 'answer' \| 'aborted' \| 'refusal' \| 'error' \| 'unknown', answer, unclosed: { settleMs, as } }` | every end is `answer`; a turn with no end closes as `error` at the next prompt |
| Commands | `commands: { entry: 'intercept' \| 'inline-script' \| 'prompt' \| 'tool' \| 'cli-only', parse, sessionOf?(env), answerReachesModel }`; an inline script runs `bin/command.mjs <host> <command>` | `cli-only` |
| Budgets | `budgets: { prompt }`, ms, the host's prompt-hook timeout; a recall waits what it leaves, at most 6 s | `prompt: 5000` |
| Owner | `owner: 'self' \| 'parent' \| { ancestor: RegExp } \| { ancestorPath: RegExp }` | `parent` |
| Headless model | `model: { kind: 'cli', command: (env) → path \| { names, dirs?(env) }, args(model, prompt), parse, input?(prompt), workdir?: 'empty', shim? } \| { kind: 'sdk', complete? } \| { kind: 'in-session' } \| null` | `null` |
| State | `stateDir(env)` | `~/.evolver/state` |
| Leftovers | `legacy: [{ rename } \| { ledgers } \| { turns } \| { retention }]`: what the host's standalone plugin left, adopted once | `[]` |

## Matrix

From each host's reviewed standalone plugin; bold is where it differs from the default.

| Point | WorkBuddy | Cursor | Antigravity | OpenCode | MCP client | Codex (later) |
|---|---|---|---|---|---|---|
| Channel | hook | hook | hook | **plugin** | **mcp** | hook |
| Prompt from | payload | payload | **transcript** | **message parts** | **`task` argument** | payload |
| Session start | event | event | **owner-change** | **first prompt in the instance** | **connection** | event |
| Answer | additionalContext | **`{continue, additional_context}`** | **`injectSteps`, replayed each model call; `allow`/`stop` empty answers** | **synthetic part** | **tool result** | additionalContext |
| Evidence | **transcript at turn end** | hook exit codes, **answer from afterAgentResponse** | **transcript step exit codes** | **`metadata.exit`** | **agent-reported** | PostToolUse / rollout |
| Turn end | **`final_stop_reason`** | **`status`, 3 s settle** | **`terminationReason`, unknown waits** | **`error.name` / `finish`** | **report `outcome`** | Stop / Interrupt / next prompt |
| Session end | event | event, **for its generation** | owner's exit | **deleted / dispose** | **connection close** | event |
| Commands | **inline-script** | **intercept** | cli-only | **prompt / TUI** | **tool** | cli-only |
| Owner | parent | **ancestor path `/cursor/`** | **ancestor `agy` / `language_server`** | **self** | **self** | **ancestor `/^codex/`** |
| Headless model | `codebuddy -p`; **the agent writes the Gene when it cannot sign in** | `cursor-agent -p --mode ask` | `agy -p`, **stream-json on stdin, empty folder** | **SDK helper session** | **in-session** | `codex exec --disable hooks,plugins` |
| State | **plugin data folder** | default | default | default | default | default |
| Installed from | **`dist/workbuddy`, packed** | the repo root (`.cursor-plugin`) | **`dist/antigravity`, packed** | **npm, packed** | **its MCP config** | `.codex-plugin` |

## Adding a host

1. `hosts/<name>/profile.js`: `export default defineProfile({ name, label, channel, events, evidence, … })` with
   only the points that differ; readers that need more than a line go in sibling files.
2. `hosts/<name>/dist/`: the host's hook registration calling `node bin/hook.mjs <name> <hostEvent>` (or its MCP
   config calling `node bin/mcp.mjs <name>`), its commands and manifests, and `pack.json` when the host cannot install
   this repo as it is (it copies one folder, loads every component folder at a plugin's root, or wants a package).
3. The host's manifest at its fixed place in the repo root when it installs the repo itself, pointing into `dist/`.
4. `test/hosts/<name>/`: every reader against payloads from the real host, and the hooks end to end, from a packed
   folder where the host installs one.

No shared file changes: `lib/agent/registry.js` finds the profile by its folder name. A difference no point covers
yet becomes a new field with a default in `lib/agent/profile.js`, used in one place in `lib/agent/driver.js`.

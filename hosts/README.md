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
| Channel | `channel: 'hook' \| 'plugin' \| 'relay' \| 'mcp'`; `relay` is a plugin channel in a Node process that a host's module, which has no Node, starts and talks to over loopback HTTP (`bin/relay.mjs <host>`) | `hook` |
| Events | `events: { hostEvent: canonicalEvent }`, onto `sessionStart`, `prompt`, `toolResult`, `beforeEdit`, `turnEnd`, `sessionEnd`, `command`, `agentGene` | — (MCP: its six tools) |
| Payload | `payload: { sessionId, turnId, prompt, projectDir, isIgnored, model, transcriptPath, gene, writtenFor }`, each `(payload, context)`; `context` has `env`, `transcriptSize()`, `transcriptSince(offset)`, and `turnStart` at a turn's end. `isIgnored` skips a subagent's event or any other that is no turn of the person's | Claude Code's field names |
| Session start | `sessionStart: 'event' \| 'owner-change' \| 'connection'` | `event` |
| Answer | `reply: { context, notice, empty, command, turnEnd, late?, lifetime: 'turn' \| 'call', strategyAt: 'prompt' \| 'tool-result' }`, each `(value, hostEvent, payload)`; `lifetime: 'call'` replays the turn's strategy before every model call; `late(answer, late)` lets a host that can add context to a running turn take a recall slower than the wait (`late` resolves to `{ text, show, join }`: `show()` while the turn is open, for a host that adds it before a model step carries it; `join()` books it once one does); `strategyAt: 'tool-result'`, for a host whose prompt hook cannot add context, holds the strategy recalled at the prompt for the open turn, unbooked, and `context(strategy, toolEvent)` answers the turn's first tool hook with it, under that tool event's name, booking it then; a turn with no tool call never gets it. Such a host takes no `owner-change` session start and no `late` | `hookSpecificOutput.additionalContext`, `{}`, `strategyAt: 'prompt'` |
| Evidence | `evidence: { toolNote, editedFile \| editedFiles, turnStart?, turnRecord?, source }`: tool notes as hooks see them, or a turn record read from the host's transcript | required |
| Turn end | `turnEnd: { reason → 'answer' \| 'aborted' \| 'refusal' \| 'error' \| 'unknown', answer, unclosed: { settleMs, as } }` | every end is `answer`; a turn with no end closes as `error` at the next prompt |
| Commands | `commands: { entry: 'intercept' \| 'inline-script' \| 'prompt' \| 'tool' \| 'cli-only', parse, sessionOf?(env), scriptArgs?(text), scriptAnswer?(result, script), answerReachesModel }`; a script runs `bin/command.mjs <host> <command> [args…]`, from a host or a terminal; `answerReachesModel` defaults to true for `inline-script`, `prompt` and `tool` | `cli-only` |
| Budgets | `budgets: { prompt }`, ms, the host's prompt-hook timeout; a recall waits what it leaves, at most 6 s. In a resident process the budget is the wait itself, and 0 makes every recall a late one | `prompt: 5000` |
| Owner | `owner: 'self' \| 'spawner' \| 'parent' \| { ancestor: RegExp } \| { ancestorPath: RegExp }`; `spawner` is the process that started this one with no shell between, on every platform | `parent` |
| Headless model | `model: { kind: 'cli', command: (env) → path \| { names, dirs?(env), accepts?(name, realPath), nodeScriptOnWindows?, windowsShims? }, args(model, prompt, { workdir, preflight }), parse, input?(prompt), workdir?: 'empty', shim?, preflight?: { args, parse({ code, stdout }) } } \| { kind: 'sdk', complete? } \| { kind: 'in-session' } \| null`; names are looked up on PATH, then in `dirs`; `preflight` runs first and either hands `args` what it found or stops the run | `null` |
| State | `stateDir(env)` | `~/.evolver/state` |
| Leftovers | `legacy: [{ folder } \| { rename } \| { sessions } \| { ledgers } \| { turns } \| { retention }]` (`folder`: an older install's state folder beside this one, moved in first): what the host's standalone plugin left, adopted file by file until none is left; its unreported injections are reported aborted at the next session start | `[]` |

Every host also honours `EVOLVER_RECALL=off`, which turns recall off, and `EVOLVER_AUTO_DISTILL=off`, which leaves distillation to `/evolver-distill`. Every host installs the plugin as `evolver-plugin`.

## Matrix

From each host's reviewed standalone plugin; bold is where it differs from the default.

| Point | Claude Code | WorkBuddy | Cursor | Antigravity | OpenCode | MCP client | Codex | DeepSeek Harness |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Channel | **relay**: a hooks module with no Node starts `bin/relay.mjs` and relays each event | hook | hook | hook | **plugin** | **mcp** | hook | **plugin** |
| Prompt from | `turn.start` text, **its origin from `prompt.submit`; a turn nobody typed is recalled for nothing** | payload | payload | **transcript** | **message parts** | **`task` argument** | payload | **the `user` messages of a turn's first `agent/pre-step`** |
| Session start | event | event | event | **owner-change** | **first prompt in the instance** | **connection** | event | **`agent/created` (`agent/session-start` before 0.2), or the first step in the process** |
| Answer | **`$.session.append` when the recall lands (budget 0), booked at the turn's next `turn.step`** | additionalContext | **`{continue, additional_context}`** | **`injectSteps`, replayed each model call; `allow`/`stop` empty answers** | **synthetic part** | **tool result** | additionalContext; **a command blocks the prompt (`decision: block`)** | **a `plugin:evolver` message appended to the step; a late recall joins the turn's next step** |
| Evidence | **`tool.call` and what it resolved to; a check is named by its description** | **transcript at turn end** | hook exit codes, **answer from afterAgentResponse** | **transcript step exit codes** | **`metadata.exit`** | **agent-reported** | hook output, **no Bash exit code**; edits from `apply_patch` patches | **`tools/execute` results: bash `value.exitCode`, else its `[exit code: N]` marker** |
| Turn end | **`turn.complete` reason; the one-line summary as `{ text }`** | **`final_stop_reason`** | **`status`, 3 s settle** | **`terminationReason`, unknown waits** | **`error.name` / `finish`** | **report `outcome`** | Stop, **Interrupt aborts** | **`turn/end` reason; `blocked` aborts** |
| Session end | event, **written only by a listening relay** | event | event, **for its generation** | **none: the next session start reports and distills a session whose owner exited** | **deleted / dispose** | **connection close** | event; **before 0.145 the next session start reports and distills a session whose owner exited** | **`session/disposed`, or the plugin's unload (headless and the TUI never dispose)** |
| Commands | **`command.run`, registered from `hooks/commands.json`; evolve sent as a prompt** | **inline-script** | **intercept** | cli-only: `node <plugin>/bin/command.mjs antigravity evolver-status` | **prompt / TUI** | **tool** | **intercept, typed without a slash** | **prompt: the dsh command registry, answered in its UI; `/evolver-evolve` a follow-up turn** |
| Owner | **spawner: Claude Code, the relay's parent** | parent | **ancestor path `/cursor/`** | **ancestor `agy` / `language_server`** | **self** | **self** | **ancestor `/^codex/i`** | **self** |
| Headless model | **the session's own (`$.model.complete`), run by the module for the relay** | `codebuddy -p`; **the agent writes the Gene when it cannot sign in** | `cursor-agent -p --mode ask` | `agy`, **stream-json on stdin, empty folder** | **SDK helper session** | **in-session** | `codex exec` on the person's own config, **its MCP servers listed and turned off first, hooks and plugins off, JSONL on stdout, empty folder** | **dsh's model service (`llm.stream`) on the session's route** |
| State | default | **plugin data folder** | default | default | default | default | default | default |
| Installed from | **`dist/claude-code` on the `release` branch** (`git-subdir`) | **`dist/workbuddy` on the `release` branch** (`git-subdir`); **the old data folder is moved in** | the repo root (`.cursor-plugin`) | **`dist/antigravity` on the `release` branch** | **`dist/opencode` on the `release` branch (an npm package, not published yet)** | **its MCP config** | **`dist/codex` on the `release` branch** (`.agents/plugins/marketplace.json`) | **`dist/dsh` on the `release` branch, as `@evomap/dsh-evolver` (`dsh plugin add -w <folder>`; npm not published yet)** |

## Adding a host

1. `hosts/<name>/profile.js`: `export default defineProfile({ name, label, channel, events, evidence, … })` with
   only the points that differ; readers that need more than a line go in sibling files.
2. `hosts/<name>/dist/`: the host's hook registration calling `node bin/hook.mjs <name> <hostEvent>` (or its MCP
   config calling `node bin/mcp.mjs <name>`), its commands and manifests, and `pack.json` when the host cannot install
   this repo as it is (it copies one folder, loads every component folder at a plugin's root, or wants a package).
3. The host's manifest at its fixed place in the repo root: the plugin itself when the host installs the repo, or a
   marketplace pointing at `dist/<host>` on the `release` branch, which CI builds from every push to `main`.
4. `test/hosts/<name>/`: every reader against payloads from the real host, and the hooks end to end, from a packed
   folder where the host installs one.

No shared file changes: `lib/agent/registry.js` finds the profile by its folder name. A difference no point covers
yet becomes a new field with a default in `lib/agent/profile.js`, used in one place in `lib/agent/driver.js`.

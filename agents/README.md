# Agents

One folder per agent. A folder holds only where that agent differs from its channel's defaults, as an
`AgentProfile` (`profile.js`, see `lib/agent/profile.js`), plus the files its host installs (`dist/`). It never
starts a process, takes a lock or reads a file itself: what has to run is declared, and `lib/runtime/` runs it.

## Difference points

| Point | Field | Default (hook channel) |
|---|---|---|
| Channel | `channel: 'hook' \| 'plugin' \| 'mcp'` | `hook` |
| Events | `events: { hostEvent: canonicalEvent }` | — (MCP: its six tools) |
| Payload | `payload: { sessionId, turnId, prompt, projectDir, isSubagent, model, transcriptPath, gene, writtenFor }` | Claude Code's field names |
| Session start | `sessionStart: 'event' \| 'owner-change' \| 'connection'` | `event` |
| Answer | `reply: { context, notice, empty, command, turnEnd, lifetime: 'turn' \| 'call' }` | `hookSpecificOutput.additionalContext`, `{}` |
| Evidence | `evidence: { toolNote, editedFile, turnStart?, turnRecord?, source }` | required |
| Turn end | `turnEnd: { reason, answer, unclosed: { settleMs, as } }` | every end is `answer`; an unclosed turn ends as `error` at the next prompt |
| Commands | `commands: { entry: 'intercept' \| 'inline-script' \| 'prompt' \| 'tool' \| 'cli-only', parse }` | `cli-only` |
| Budgets | `budgets: { prompt, … }` in ms, matching the host's hook timeouts | `prompt: 5000` |
| Owner | `owner: 'self' \| 'parent' \| { ancestor: RegExp }` | `parent` |
| Headless model | `model: { kind: 'cli', command, args, parse, shim? } \| { kind: 'sdk', complete } \| { kind: 'in-session' } \| null` | `null` |
| State | `stateDir(env)` | `~/.evolver/state` |

## Matrix

From each agent's reviewed standalone plugin; bold is where it differs from the default.

| Point | WorkBuddy | Cursor | Antigravity | OpenCode | MCP client | Codex (later) |
|---|---|---|---|---|---|---|
| Channel | hook | hook | hook | **plugin** | **mcp** | hook |
| Prompt from | payload | payload | **transcript** | **message parts** | **`task` argument** | payload |
| Session start | event | event | **owner-change** | **plugin load** | **connection** | event |
| Answer | additionalContext | **`{continue, additional_context}`** | **`injectSteps`, replayed each model call; `allow`/`stop` empty answers** | **synthetic part** | **tool result** | additionalContext |
| Evidence | **transcript at turn end** | hook exit codes | **transcript step exit codes** | **`metadata.exit` + part updates** | **agent-reported** | PostToolUse / rollout |
| Turn end | **`final_stop_reason`** | **`status`, 3 s settle** | **`terminationReason`, unknown waits** | **`error.name` / `finish`** | **report `outcome`** | Stop / Interrupt / next prompt |
| Session end | event | event | owner-gone | **dispose** | **connection close** | event |
| Commands | **inline-script** | **intercept** | cli-only | **prompt / TUI** | **tool** | cli-only |
| Owner | parent | port's process chain | port's process chain | **self** | **self** | **ancestor `/^codex/`** |
| Headless model | `codebuddy -p`, **agent writes the Gene when it cannot sign in** | `cursor-agent -p --mode ask` | `agy -p` | **SDK helper session** | **in-session** | `codex exec --disable hooks,plugins` |
| State | **plugin data folder** | default | default | default | default | default |
| Installed from | `.codebuddy-plugin` marketplace | `.cursor-plugin` | **whole repo or local path** | **npm package** | **MCP config** | `.codex-plugin` |

## Adding an agent

1. `agents/<name>/profile.js`: `export default defineProfile({ name, label, channel, events, evidence, … })`, only the
   points that differ; small readers in sibling files when they need more than a line.
2. `agents/<name>/dist/`: the host's hook registration calling `node bin/hook.mjs <name> <hostEvent>` (or the MCP
   config calling `node bin/mcp.mjs <name>`), and its commands.
3. The host's manifest at its fixed place in the repo root, pointing into `dist/`.
4. `test/agents/<name>/`: each reader against payloads captured from the real host, and the hooks end to end.

No shared file changes: `lib/agent/registry.js` finds the profile by its folder name. A difference no point covers
yet becomes a new field with a default in `lib/agent/profile.js`, used in one place in `lib/agent/driver.js`.

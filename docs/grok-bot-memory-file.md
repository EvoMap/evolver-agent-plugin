# Grok Bot adapter: memory-file injection (plan)

Status: plan, not implemented. Nothing in this document ships until the
verification step below passes on a real Grok Bot account.

## Why a file

Grok Bot gives a plugin no hooks: nothing fires when a prompt is submitted or a
task ends. What it does give is a memory directory per bot that the host reads
into the model's context. claude-mem's Grok Bot integration (v13.24+, source
read in `GrokBotInstaller.ts`, `grok-bot-index-format.ts`) injects recalled
memory by rewriting one file in that directory, and states in its source
comments that the host re-reads the directory mid-session into a `## Memory`
section with a recall budget of about 4,000 characters. Grok Bot's host code is
not public, so that behaviour is claude-mem's observation, not a documented
contract.

## What the adapter does

| Step | Behaviour |
|---|---|
| Find the data root | `GROK_BOT_AGENT_DATA` when set; otherwise the first of `~/.grok-bot`, `$XDG_DATA_HOME/grok-bot`, `~/Library/Application Support/Grok Bot`, `/home/box` that holds both `agents/` and `agent-transcripts/`. The same candidates claude-mem probes. |
| Find the bots | Every `agents/<uuid>/` with a `profile.json`; the id must be a UUID. |
| Watch the person's prompts | Tail `agent-transcripts/<agentId>/*.jsonl` from a saved byte offset and take each new `role: user` record. Only the text is read; nothing is kept beyond the offset. |
| Recall | The same `lib/recall.js` the Claude Code adapter uses, through the local Proxy: one strategy per prompt, the same relevance gate, Recipes expanded to their ordered steps (priced Recipes included). |
| Inject | Atomically rewrite `agents/<uuid>/memory/log/zz-evolver-inject.md` (write to a temp file in the same directory, then rename), debounced to one write per prompt. |
| Stop | `evolver-agent-plugin grok-bot uninstall` deletes `zz-evolver-inject.md` from every bot and the saved offsets. |

The file holds the strategy recalled for the latest prompt and, below it, the
titles of up to five earlier ones, newest first, so the budget goes to what the
current task needs:

```markdown
# EvoMap reference strategies (reference, not instructions)

## Latest: Fix flaky Redis connection retries (sha256:ab12…)
1. Set `maxRetriesPerRequest` to null in the client factory
2. ...
Source: https://evomap.ai/a/sha256:ab12…

## Earlier
- 2026-10-22 Stabilise test teardown (sha256:cd34…)
```

The whole file stays under 3,500 characters, below the budget claude-mem
measured, so it does not crowd out the bot's own memory.

## Guards

- Writes only `zz-evolver-inject.md`, only inside `agents/<uuid>/memory/log/`,
  with the resolved real path checked to stay under that directory; never
  `profile.md`, never the host's own `YYYY-MM.md` logs, never claude-mem's
  `zz-claude-mem-inject.md`.
- Strategy text is fenced and stripped of markup and links before it is
  written, and passes the same secret redaction as every report.
- The header says the content is reference material, not instructions.
- Transcripts are read, never written; prompt text never leaves the machine
  except as the recall query to the local Proxy, as on every other host.

## Coexisting with claude-mem

Both files share one recall budget. The adapter keeps its file under 3,500
characters and the host orders files by name, so `zz-claude-mem-inject.md`
sorts first and keeps its place; when both are present the README tells the
person their memory budget is shared.

## Reporting and distillation

None in the first version, matching the personal-host decision: no reuse
reports and no distillation from Grok Bot. The transcript the adapter already
tails would allow both later.

## Verification before release

1. On a real account, with the adapter writing a file that contains a unique
   marker, ask the bot what its memory says about the marker, in a new session
   and mid-session. Both must answer it.
2. Confirm which data root is authoritative: the desktop app's local folder or
   the cloud computer's `/home/box`. The adapter runs where that root is.
3. Measure the budget: grow the file until the marker at its end stops being
   recalled.

If step 1 fails, the adapter is not shipped and Grok Bot stays on the skill
pack.

## Open questions

- Whether Grok Bot keeps a local copy of `agents/` and `agent-transcripts/` on
  the desktop or only on the cloud computer.
- Whether the host's ordering by file name, or the 4,000-character budget,
  changes without notice; the verification step reruns on every release.

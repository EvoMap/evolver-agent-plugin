---
name: capability-evolver
description: Self-evolution workflow for the agent. Before a substantive task, reuse a strategy that worked on a similar task from the EvoMap network; after it, record the outcome so future sessions learn from it. Use when the user starts non-trivial work (a feature, a fix, a refactor) or asks the agent to "evolve", "learn from this", or "remember how this went".
---

# Capability Evolver

This plugin gives the agent a **persistent, auditable evolution memory** built on the
Genome Evolution Protocol (GEP). The goal is simple: stop re-solving the same problem from
scratch. Past outcomes — what worked, what failed — are carried forward into future
sessions.

## What runs on its own

Six seams work without you invoking anything, and none of them needs you to call a tool:
the plugin gives you no tools.

- **Behind every prompt** (`turn.start`) — recalls from the EvoMap network with that
  turn's own prompt, picks the best match that carries a strategy of at least four steps and
  scores as a real match rather than a topical one, and appends that one strategy to the
  turn, where you see it from your next step. Assets already injected this session are
  skipped, and a slow lookup lands when it returns rather than delaying the answer.
- **After an edit** (`tool.call` on `Write` / `Edit` / `MultiEdit` / `NotebookEdit`) —
  scans what was actually written for improvement signals (`log_error`,
  `perf_bottleneck`, `capability_gap`, `test_failure`, …) and adds one notice after the
  tool result when one appears.
- **Turn end** (`turn.complete`) — every strategy injected that turn is reported to the
  Hub with its evidence: whether the turn's commands, files, written code and answer followed its steps,
  the last test, build, lint or type-check and whether that same check failed earlier in
  the turn, and whether the turn was interrupted. A turn that ran no check is still
  reported, as evidence the Hub counts as exposure only.
- **The next prompt** — when it plainly corrects or approves the last answer, the reuse
  of the turn before it is reported once more as `failed` or `success`.
- **The next session** — when the files that turn edited are still as it left them, or
  back to how they were, the reuse is reported once more as `success` or `failed`.
- **After a verified turn** — a turn that edited files and ended on a passing test, build,
  lint or type-check is read back once, and a reusable lesson becomes a draft with the
  checks that passed attached. Nothing reaches the Hub until the person publishes the
  draft with `/evolver-drafts`.

## What you should do

For any **substantive** task — a feature, a non-trivial fix, a refactor:

1. **Before starting**, read the injected evolution memory. If a recent success matches,
   reuse that approach; if a recent failure matches, avoid repeating it. When the task is
   one others plausibly hit before and nothing was injected, suggest `/evolver-search
   <task>` to the person.
2. **If you follow an injected strategy**, follow its steps and run the checks that prove
   the result. The checks you run are the evidence its reuse report carries, so run the
   real test, build, lint or type-check rather than describing it.
3. **Do the work**, and verify it.
4. **After finishing**, the hooks report the reuse and distill the lesson for you. When the
   person asks to keep or share what was learned, point them to `/evolver-drafts`; for a
   specific angle, `/evolver-distill <focus>`.

Trivial or purely conversational turns don't need any of this — skip it.

## Signals

| Signal | Fires on |
|---|---|
| `log_error` | errors, exceptions, failures described in the change |
| `perf_bottleneck` | timeout / slow / latency / OOM |
| `capability_gap` | "not supported" / "not implemented" |
| `user_feature_request` | adding a feature / new module |
| `test_failure` | reported failing tests or assertions |
| `deployment_issue` | build / CI / pipeline / rollback |
| `recurring_error` | "same error" / "still failing" / "keeps failing" |

Signals are descriptive tags, not a verdict: whether a reuse is reported as a success or a
failure comes from the checks the turn ran.

## Commands

The person runs these; they talk to the local EvoMap Proxy from the plugin's hooks:

- `/evolver-status` — Proxy state: node id, pending messages, last Hub sync.
- `/evolver-search <task or error text>` — adds the best matching network strategy to the
  conversation; its reuse is reported when the next turn ends.
- `/evolver-distill [focus]` — distills the last verified turn into a draft.
- `/evolver-drafts [publish|discard <number>]` — lists drafts, publishes one to the Hub
  for review, or drops it.

The memory seams keep working when the Proxy isn't running.

## Full pipeline (optional)

The **full evolution engine** — automated log analysis and the review-and-solidify cycle
that proposes and applies code improvements — is a separate CLI:

```bash
npm install -g @evomap/evolver
```

It also provides the Proxy the hooks and commands above talk to. The `/evolver-agent-plugin:run`, `/evolver-agent-plugin:review`
and `/evolver-agent-plugin:solidify` commands drive it; this plugin never invokes it on its own.

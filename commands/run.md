---
description: Run one Evolver self-evolution cycle on the current repo (collect signals → select/mutate genes → propose changes).
argument-hint: "[--loop] [--dry-run] [--strategy=balanced|innovate|harden|repair-only]"
---

Run one Evolver cycle in the **current git repository**.

`$ARGUMENTS` is the exact user suffix. Preserve its argument order, and never drop a protective
flag such as `--dry-run` or invent a flag the user did not provide.

1. Confirm `git rev-parse --is-inside-work-tree` succeeds. Otherwise explain that Evolver
   requires git and stop.
2. Use the installed `evolver` executable when available; otherwise use
   `npx -y @evomap/evolver`.
3. Invoke its `run` subcommand followed by those arguments. When the user
   supplied no strategy, preserve the environment's `EVOLVE_STRATEGY` or use `balanced`.
4. Summarize the collected signals, selected or mutated gene, and whether changes are
   pending solidify. Point pending work to `/evolver-agent-plugin:review`; rejection is
   `/evolver-agent-plugin:review --reject`.

Do not approve pending changes automatically.

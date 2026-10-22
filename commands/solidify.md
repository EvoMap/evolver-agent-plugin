---
description: Solidify the current working changes into a durable Evolver gene/capsule (with rollback safety).
argument-hint: "[--dry-run] [--intent=repair|optimize|innovate] [--summary=\"...\"]"
---

Solidify the current working-tree changes into a durable Evolver asset.

1. Confirm the current directory is a git repository and show `git diff --stat` so the
   user sees what will be captured.
2. Read the user's arguments: `$ARGUMENTS`. Use the installed
   `evolver` executable, or `npx -y @evomap/evolver` when absent, and invoke its `solidify`
   subcommand followed by those exact arguments.
3. If no `--summary` was supplied, derive a concise one-line summary from the diff and add
   it explicitly. Do not change any other user flag.
4. Report the Gene or Capsule created or updated and whether a rollback point was recorded.

Recommend `--dry-run` before a write when the user did not already choose it.

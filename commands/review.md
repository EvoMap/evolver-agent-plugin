---
description: Review Evolver's pending evolved changes, then approve (solidify) or reject (roll back).
argument-hint: "[--approve | --reject]"
---

Review the changes Evolver currently has **pending solidify** in this repository.

1. Show `git status --short` and `git diff HEAD` so the user sees the proposed edits.
2. Read the user's arguments: `$ARGUMENTS`.
3. Use the installed `evolver` executable, or `npx -y @evomap/evolver` when absent:
   - `--approve` or an explicit request to accept: invoke `review --approve`.
   - `--reject` or an explicit request to discard: invoke `review --reject`.
   - Empty or ambiguous input: summarize the pending diff and ask the user to choose before
     running either state-changing command.
4. Report the final state and resulting git status.

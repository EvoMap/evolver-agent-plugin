---
description: "Sync assets between the local store and the EvoMap Hub (evolver sync)."
argument-hint: "[--scope=…] [--type=…] [--dry-run]"
---

The Evolver plugin answers `/evolver-sync [--scope=…] [--type=…] [--dry-run]` itself, from its UserPromptSubmit hook, before this prompt reaches you.

If you are reading this, that hook did not run. Do not run any tool for it: tell the user that the Evolver plugin's hooks are not active in this Qoder session (`/hooks` lists them), and that `qodercli plugins enable evolver-plugin` and a new session bring them back.

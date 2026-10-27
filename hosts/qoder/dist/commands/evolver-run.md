---
description: "Run one Evolver self-evolution cycle on this repository (evolver run)."
argument-hint: "[--loop] [--dry-run] [--strategy=…]"
---

The Evolver plugin answers `/evolver-run [--loop] [--dry-run] [--strategy=…]` itself, from its UserPromptSubmit hook, before this prompt reaches you.

If you are reading this, that hook did not run. Do not run any tool for it: tell the user that the Evolver plugin's hooks are not active in this Qoder session (`/hooks` lists them), and that `qodercli plugins enable evolver-plugin` and a new session bring them back.

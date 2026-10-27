---
description: "Find the EvoMap strategy that best fits a task; where the agent sees the answer, its reuse is reported."
argument-hint: "<task description or error text>"
---

The Evolver plugin answers `/evolver-search <task description or error text>` itself, from its UserPromptSubmit hook, before this prompt reaches you.

If you are reading this, that hook did not run. Do not run any tool for it: tell the user that the Evolver plugin's hooks are not active in this Qoder session (`/hooks` lists them), and that `qodercli plugins enable evolver-plugin` and a new session bring them back.

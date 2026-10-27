---
description: "Review Evolver's pending evolved changes, then approve or reject them (evolver review)."
argument-hint: "[--approve | --reject]"
---

The Evolver plugin answers `/evolver-review [--approve | --reject]` itself, from its UserPromptSubmit hook, before this prompt reaches you.

If you are reading this, that hook did not run. Do not run any tool for it: tell the user that the Evolver plugin's hooks are not active in this Qoder session (`/hooks` lists them), and that `qodercli plugins enable evolver-plugin` and a new session bring them back.

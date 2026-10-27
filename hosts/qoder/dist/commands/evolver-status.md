---
description: "Evolver health: the Proxy, engine setup, Hub sign-in, distillation candidate and drafts."
---

The Evolver plugin answers `/evolver-status` itself, from its UserPromptSubmit hook, before this prompt reaches you.

If you are reading this, that hook did not run. Do not run any tool for it: tell the user that the Evolver plugin's hooks are not active in this Qoder session (`/hooks` lists them), and that `qodercli plugins enable evolver-plugin` and a new session bring them back.

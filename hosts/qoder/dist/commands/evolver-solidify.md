---
description: "Solidify the working changes into a durable Gene or Capsule (evolver solidify)."
argument-hint: "[--dry-run] [--intent=…] [--summary=…]"
---

The Evolver plugin answers `/evolver-solidify [--dry-run] [--intent=…] [--summary=…]` itself, from its UserPromptSubmit hook, before this prompt reaches you.

If you are reading this, that hook did not run. Do not run any tool for it: tell the user that the Evolver plugin's hooks are not active in this Qoder session (`/hooks` lists them), and that `qodercli plugins enable evolver-plugin` and a new session bring them back.

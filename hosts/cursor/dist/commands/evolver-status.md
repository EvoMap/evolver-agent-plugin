---
description: "Evolver health: the Proxy, engine setup, Hub sign-in, distillation candidate and drafts."
---

The Evolver plugin answers `/evolver-status` itself, from its beforeSubmitPrompt hook, before this prompt reaches you.

If you are reading this, that hook did not run. Do not run any tool for it: tell the user that the Evolver plugin's hooks are not active in this Cursor window (Settings → Hooks shows them) and that reloading the window or reinstalling the plugin brings them back.

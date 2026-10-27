---
description: "Sign in to the EvoMap Hub with a device code, setting Evolver up first when needed, and show the registered node."
---

The Evolver plugin answers `/evolver-login` itself, from its beforeSubmitPrompt hook, before this prompt reaches you.

If you are reading this, that hook did not run. Do not run any tool for it: tell the user that the Evolver plugin's hooks are not active in this Cursor window (Settings → Hooks shows them) and that reloading the window or reinstalling the plugin brings them back.

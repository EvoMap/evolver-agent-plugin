---
description: "Run an evolution checkpoint: recall past outcomes, reflect on the current task, record the lesson."
argument-hint: "[focus]"
---

Run the evolution checkpoint the Evolver plugin attached to this prompt.

If no checkpoint is attached, the plugin's UserPromptSubmit hook did not run: tell the user that the Evolver plugin's hooks are not active in this Qoder session (`/hooks` lists them), and that `qodercli plugins enable evolver-plugin` and a new session bring them back.

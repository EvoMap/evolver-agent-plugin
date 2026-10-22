---
description: Run an evolution checkpoint — recall relevant past outcomes, reflect on the current task, and record what was learned.
---

Take a deliberate evolution step for the current task.

1. **Recall.** Look at the evolution memory this plugin injected at session start, or read
   the tail of the memory graph — `~/.evolver/memory/evolution/memory_graph.jsonl`, or the
   project's `memory/evolution/memory_graph.jsonl` when it exists. Summarize any recent
   outcome — success or failure — relevant to what we're working on. When the task looks
   like something others have hit, suggest the person run `/evolver-search <task>`, which
   adds the best matching network strategy to the conversation.

2. **Reflect.** Given the current diff and task state, say in one or two lines: what
   worked, what didn't, and what the durable lesson is.

3. **Record.** The reuse of an injected strategy is reported automatically at every turn
   end, and a turn that edited files and ended on a passing check is distilled into a
   draft automatically. Point the person to `/evolver-drafts` to publish or discard it, or
   to `/evolver-distill [focus]` to distill the last verified turn on request. To run the
   full engine now, use `/evolver-agent-plugin:run`.

Keep this lightweight — it is an explicit checkpoint, not a ceremony on every turn.

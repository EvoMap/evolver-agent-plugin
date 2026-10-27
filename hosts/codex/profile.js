// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { EVENTS } from '../../lib/agent/events.js';
import { defineProfile } from '../../lib/agent/profile.js';
import { promptCommandOf } from './commands.js';
import { editedFilesOf, toolNoteOf } from './evidence.js';
import { headlessCodex } from './headless.js';

// A turn that ended on an error runs neither Stop nor Interrupt, so the next prompt closes it. Codex runs each hook
// through `$SHELL -lc` in a process session of its own, so the session's owner is the nearest ancestor named codex*:
// the CLI, or the app's app-server.

const INTERRUPT = 'Interrupt';

const text = (value) => (typeof value === 'string' ? value : '');

export default defineProfile({
  name: 'codex',
  label: 'Codex',
  events: {
    SessionStart: EVENTS.SESSION_START,
    UserPromptSubmit: EVENTS.PROMPT,
    PreToolUse: EVENTS.BEFORE_EDIT,
    PostToolUse: EVENTS.TOOL_RESULT,
    Stop: EVENTS.TURN_END,
    [INTERRUPT]: EVENTS.TURN_END,
    SessionEnd: EVENTS.SESSION_END,
  },
  payload: {
    model: (payload) => (text(payload.model) ? { model: payload.model } : null),
  },
  reply: {
    // A blocked prompt reaches no model and opens no turn; Codex shows the reason to the person.
    command: (result) => ({ decision: 'block', reason: result.text }),
  },
  evidence: { toolNote: toolNoteOf, editedFiles: editedFilesOf },
  turnEnd: {
    reason: (payload, context) => ((context?.hostEvent ?? payload.hook_event_name) === INTERRUPT ? 'aborted' : 'answer'),
  },
  commands: { entry: 'intercept', parse: (payload, hostEvent, { prompt }) => promptCommandOf(prompt) },
  // UserPromptSubmit also answers the evolver-* commands, which may run the evolver CLI for ten minutes.
  budgets: { prompt: 660_000 },
  owner: { ancestor: /^codex/i },
  model: headlessCodex,
  legacy: [{ ledgers: /^codex-injected-[0-9a-f]{16}\.json$/ }],
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { additionalContextReply } from '../../lib/agent/defaults/hook.js';
import { EVENTS, STRATEGY_AT } from '../../lib/agent/events.js';
import { defineProfile } from '../../lib/agent/profile.js';
import { endedTurnSummaryOf } from '../../lib/turn-summary.js';
import { promptCommandOf } from './commands.js';
import { editedFileOf, toolNoteOf } from './evidence.js';
import { headlessGrok } from './headless.js';

const PROMPT = 'UserPromptSubmit';
const STOP = 'Stop';
const COMPLETED = 'end_turn';
const TURN_ENDS = { [STOP]: 'answer', StopFailure: 'error', StopCancelled: 'aborted' };

const text = (value) => (typeof value === 'string' ? value : '');

// A Stop without a promptId is the one grok fires at session end (`shutdown`, `channel_closed`): no turn ended.
function turnEndReasonOf(payload, context) {
  const hostEvent = context?.hostEvent ?? payload.hook_event_name;
  if (!text(payload.promptId)) return 'unknown';
  if (hostEvent === STOP && payload.reason !== COMPLETED) return 'unknown';
  return TURN_ENDS[hostEvent] ?? 'unknown';
}

export default defineProfile({
  name: 'grok',
  label: 'Grok',
  events: {
    SessionStart: EVENTS.SESSION_START,
    [PROMPT]: EVENTS.PROMPT,
    PreToolUse: EVENTS.BEFORE_EDIT,
    PostToolUse: EVENTS.TOOL_RESULT,
    PostToolUseFailure: EVENTS.TOOL_RESULT,
    [STOP]: EVENTS.TURN_END,
    StopFailure: EVENTS.TURN_END,
    StopCancelled: EVENTS.TURN_END,
    SessionEnd: EVENTS.SESSION_END,
  },
  payload: {
    turnId: (payload) => text(payload.promptId) || null,
    isIgnored: (payload) => Boolean(payload.subagentType),
    // grok's hooks name no model, so the distillation runs on the default model of the person's config.
    model: () => ({ model: null }),
  },
  reply: {
    // grok discards what an allowing prompt hook prints; a tool hook's additionalContext reaches the model after
    // that tool's result, and a PostToolUse's survives a deny or a rejected approval, which drop a PreToolUse's.
    strategyAt: STRATEGY_AT.TOOL_RESULT,
    // /evolver-evolve's checkpoint comes to the model from its command file instead.
    context: (text, hostEvent) => (hostEvent === PROMPT ? {} : additionalContextReply.context(text, hostEvent)),
    // A SessionStart hook's systemMessage is shown to the person only.
    notice: (notice) => (notice ? { systemMessage: notice } : {}),
    // A blocked prompt reaches no model and opens no turn; grok shows the reason to the person.
    command: (result) => ({ decision: 'block', reason: result.text }),
    turnEnd: (ended, hostEvent) => {
      const line = hostEvent === STOP ? endedTurnSummaryOf(ended, { reason: 'answer' }) : null;
      return line ? { systemMessage: line } : {};
    },
  },
  evidence: { toolNote: toolNoteOf, editedFile: editedFileOf },
  turnEnd: {
    reason: turnEndReasonOf,
    answer: (payload) => text(payload.lastAssistantMessage),
    // A cancelled turn's StopCancelled may come after the next prompt; a turn replaced by a message typed while it
    // ran (cancel-and-send) or rewound reports no end at all.
    unclosed: { settleMs: 2_000, as: 'aborted' },
  },
  commands: { entry: 'intercept', parse: (payload, hostEvent, { prompt }) => promptCommandOf(prompt) },
  // UserPromptSubmit also answers the evolver-* commands, which may run the evolver CLI for ten minutes.
  budgets: { prompt: 660_000 },
  model: headlessGrok,
});

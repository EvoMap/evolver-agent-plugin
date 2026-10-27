// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { EVENTS } from '../../lib/agent/events.js';
import { defineProfile } from '../../lib/agent/profile.js';
import { modelOf, personTextOf } from './messages.js';
import { editedFilesOf, toolNoteOf } from './tools.js';
import { turnEndReason } from './turn-end.js';

const PROMPT_EVENT = 'agent/pre-step';

const text = (value) => (typeof value === 'string' ? value : '');

// A turn no person's message opened (a goal round, a scheduled run, a job's completion notice) is no task of the
// person's; `/evolver-evolve` opens one with the instructions it hands the agent, as a command turn.
const isOtherProducersTurn = (payload, hostEvent) => hostEvent === PROMPT_EVENT && !payload.command && !personTextOf(payload.messages);

export default defineProfile({
  name: 'dsh',
  label: 'DeepSeek Harness',
  channel: 'plugin',
  events: {
    'agent/created': EVENTS.SESSION_START,
    'agent/session-start': EVENTS.SESSION_START,
    [PROMPT_EVENT]: EVENTS.PROMPT,
    'tools/execute:before': EVENTS.BEFORE_EDIT,
    'tools/execute': EVENTS.TOOL_RESULT,
    'turn/end': EVENTS.TURN_END,
    'session/disposed': EVENTS.SESSION_END,
    dispose: EVENTS.SESSION_END,
    'command/run': EVENTS.COMMAND,
  },
  payload: {
    sessionId: (payload) => text(payload.sessionId) || null,
    turnId: (payload) => (Number.isInteger(payload.turn) ? String(payload.turn) : null),
    hostTurn: (payload) => (Number.isInteger(payload.turn) ? payload.turn : null),
    prompt: (payload) => personTextOf(payload.messages),
    projectDir: (payload) => text(payload.cwd) || null,
    isIgnored: (payload, context) => payload.origin === 'subagent' || isOtherProducersTurn(payload, context.hostEvent),
    model: (payload) => modelOf(payload.lastAssistant),
  },
  reply: {
    context: (strategy) => (strategy ? { strategy } : {}),
    notice: (notice) => (notice ? { notice } : {}),
    empty: () => ({}),
    command: (result) => ({
      ok: result.ok,
      text: result.text,
      ...(result.forAgent && { forAgent: true }),
      ...(result.strategy && { strategy: result.strategy.text }),
    }),
    turnEnd: () => ({}),
    late: (answer, late) => ({ ...answer, late }),
    lifetime: 'turn',
  },
  evidence: { toolNote: toolNoteOf, editedFiles: editedFilesOf },
  turnEnd: {
    reason: turnEndReason,
    answer: (payload) => text(payload.answer),
  },
  commands: {
    entry: 'prompt',
    parse: (payload) => (payload.command ? { name: payload.command, args: text(payload.arguments).trim() } : null),
  },
  model: { kind: 'sdk' },
  legacy: [
    { ledgers: /^injected-[0-9a-f]{16}\.json$/ },
    { rename: /^(?:reports-outbox|distill-pending)\.json$/ },
    { retention: 'retention-pending.json' },
  ],
});

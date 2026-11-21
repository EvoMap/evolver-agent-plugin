// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { EVENTS } from '../../lib/agent/events.js';
import { defineProfile } from '../../lib/agent/profile.js';
import { withoutSecrets } from '../../lib/redact.js';
import { turnRecordOf } from '../../lib/turn/record.js';

function stateDir(env) {
  const home = env.COPILOT_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.copilot');
  if (!isAbsolute(home)) throw new Error('Copilot CLI requires an absolute profile path');
  return join(home, 'evolver');
}

export default defineProfile({
  name: 'copilot',
  label: 'GitHub Copilot CLI',
  channel: 'plugin',
  persistDistillationInProxy: false,
  events: {
    session_start: EVENTS.SESSION_START, prompt: EVENTS.PROMPT,
    terminal: EVENTS.TURN_END, session_end: EVENTS.SESSION_END,
  },
  payload: {
    sessionId: (payload) => payload.sessionId,
    turnId: (payload) => payload.turnId,
    prompt: (payload) => payload.prompt,
    projectDir: (payload) => payload.cwd,
    model: () => null,
    isIgnored: (payload) => typeof payload.cwd !== 'string' || !isAbsolute(payload.cwd),
  },
  reply: {
    context: (strategy) => ({ strategy }),
    notice: () => ({}),
    empty: () => ({}),
    command: (result) => result,
    turnEnd: () => ({}),
    lifetime: 'turn',
  },
  evidence: {
    toolNote: () => null,
    editedFiles: () => [],
    turnRecord: (payload) => turnRecordOf(payload.notes, { pairShellCalls: true }),
  },
  turnEnd: {
    reason: (payload) => payload.reason,
    answer: (payload) => withoutSecrets(payload.answer ?? ''),
  },
  commands: {
    scriptAnswer: (result) => result.agentGene
      ? ['Let Copilot write the following JSON in the selected session. Pass the JSON to evolver-distill --post with this reference.',
        result.agentGene.writtenFor, result.agentGene.prompt].join('\n\n')
      : result.text,
  },
  stateDir,
});

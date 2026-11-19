// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { EVENTS } from '../../lib/agent/events.js';
import { defineProfile } from '../../lib/agent/profile.js';
import { withoutSecrets } from '../../lib/redact.js';
import { turnRecordOf } from '../../lib/turn/record.js';

function stateDir(env) {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const data = env.CLINE_DATA_DIR?.trim() || join(env.CLINE_DIR?.trim() || join(home, '.cline'), 'data');
  if (!isAbsolute(data)) throw new Error('Cline requires an absolute data directory');
  return join(data, 'evolver-plugin');
}

export default defineProfile({
  name: 'cline', label: 'Cline CLI', channel: 'plugin', model: { kind: 'sdk' },
  events: {
    session_start: EVENTS.SESSION_START, before_run: EVENTS.PROMPT,
    after_run: EVENTS.TURN_END, session_end: EVENTS.SESSION_END, command: EVENTS.COMMAND,
  },
  payload: {
    sessionId: ({ sessionId }) => sessionId,
    turnId: ({ turnId }) => turnId,
    prompt: ({ prompt }) => prompt ?? '',
    projectDir: ({ cwd }) => cwd,
    isIgnored: () => false,
    model: ({ model }) => model ?? null,
  },
  reply: {
    context: (strategy) => ({ strategy }),
    empty: () => ({}), notice: () => ({}), command: (result) => result,
    turnEnd: () => ({}), lifetime: 'call',
  },
  evidence: {
    toolNote: () => null,
    editedFiles: () => [],
    turnRecord: ({ notes }) => notes && turnRecordOf(notes),
  },
  turnEnd: {
    reason: ({ reason }) => reason,
    answer: ({ answer }) => withoutSecrets(answer ?? ''),
    modelOf: () => null,
  },
  commands: { parse: ({ command, args }) => command ? { name: command, args } : null },
  stateDir,
  settingsFile: (env) => join(stateDir(env), 'cline-settings.json'),
});

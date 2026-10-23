#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The adapter for hosts that run hooks as commands (Codex, Muse Code): one
// JSON event on stdin, one JSON answer on stdout, and never a failure the
// host would show the person.

import { codexTurnOf } from '../lib/codex/transcript.js';
import {
  otherSessionFiles, proxyFetchFrom, readHookInput, sessionFile, stateDirOf, transcriptChunkFrom, transcriptSizeOf,
} from '../lib/command-hooks/node-io.js';
import { onPromptSubmit, onSessionStart, onTurnEnd } from '../lib/command-hooks/turns.js';
import { recordReuseLocally } from '../lib/local-ledger.js';

const RECALL_WAIT_MS = 9_000;
const MIN_SIMILARITY = 0.3;

const nothingObserved = () => ({ checks: [], commands: [], paths: [], edits: [], changedLines: 0, answer: '' });

// Muse Code's transcript format is not published; until a real one is read,
// its turns report what the hook payload carries and nothing more.
const HOSTS = {
  codex: { turnOf: codexTurnOf },
  'muse-code': { turnOf: nothingObserved },
};

const isSubagentStop = (input) => typeof input?.agent_id === 'string' && input.agent_id !== '';

async function answer(host, event, input, env) {
  const sessionId = `${host}:${input?.session_id ?? 'unknown'}`;
  const dir = stateDirOf(env, host);
  const session = sessionFile(dir, input?.session_id);
  const io = {
    ...session,
    proxyFetch: proxyFetchFrom(env),
    recordLocally: recordReuseLocally,
    onRejected: async () => {},
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms).unref()),
    recallWaitMs: RECALL_WAIT_MS,
    minSimilarity: MIN_SIMILARITY,
    promptEventName: 'UserPromptSubmit',
    turnOf: HOSTS[host].turnOf,
  };
  if (event === 'SessionStart') return onSessionStart(io, { otherSessions: otherSessionFiles(dir, input?.session_id) });
  if (event === 'UserPromptSubmit') {
    return onPromptSubmit(io, { sessionId, input, transcriptSize: transcriptSizeOf(input?.transcript_path) });
  }
  if (event === 'Stop' && !isSubagentStop(input)) {
    const offset = session.readState().mark?.offset;
    return onTurnEnd(io, { sessionId, input, transcriptChunk: transcriptChunkFrom(input?.transcript_path, offset) });
  }
  return {};
}

const [host, event] = process.argv.slice(2);
let output = {};
try {
  if (HOSTS[host]) output = await answer(host, event, await readHookInput(), process.env);
} catch {
  output = {};
}
process.stdout.write(JSON.stringify(output), () => process.exit(0));

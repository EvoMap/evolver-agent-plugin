// Sessions of work for the distillation tests, driven through the use cases a host's events reach.

import { readFileSync } from 'node:fs';

import { promptSubmitted } from '../../lib/app/prompt.js';
import { toolFinished } from '../../lib/app/tool-result.js';
import { turnEnded } from '../../lib/app/turn-end.js';

/** A session Gene IR that passes the plugin's shape check, as the fake models answer it. */
export const IR = JSON.parse(readFileSync(new URL('../fixtures/session-ir.json', import.meta.url), 'utf8'));

export const DRAFTED = {
  ok: true, status: 'draft', publishable: false, distill_id: 'd'.repeat(16), quality: { ok: true }, signals: ['redis'],
  gene: { type: 'Gene', asset_id: 'sha256:' + 'g'.repeat(64), summary: IR.capability_summary },
  capsule: { type: 'Capsule', asset_id: 'sha256:' + 'c'.repeat(64), summary: IR.capability_summary },
};

export const FAILED_OUTPUT = 'ℹ tests 3\nℹ pass 2\nℹ fail 1\nMaxRetriesPerRequestError: Reached the max retries per request limit';

export const modelAnswering = (answer, onCall = () => {}) => ({
  complete: async () => {
    await onCall();
    return { answer: typeof answer === 'string' ? answer : JSON.stringify(answer), usage: { inputTokens: 10, outputTokens: 5 } };
  },
});

const STEP_NOTES = {
  edit: (path) => ({ kind: 'edit', paths: [path] }),
  pass: (command) => ({ kind: 'shell', command, exit: 0, output: 'ℹ pass 3\nℹ fail 0' }),
  fail: (command) => ({ kind: 'shell', command, exit: 1, output: FAILED_OUTPUT }),
  run: (command) => ({ kind: 'shell', command, exit: 0, output: '' }),
  note: (note) => note,
};

/** One turn of `steps`, each `[kind, argument]` with kind edit, pass, fail, run or note (a tool note as is), ended with `answer`. */
export async function turnOf(ports, sessionId, { prompt = 'fix the flaky redis retries', steps = [], answer = 'Done.', model = 'model-x', projectDir = '/proj' } = {}) {
  await promptSubmitted(ports, { sessionId, prompt, projectDir, waitMs: 1_000 });
  for (const [kind, argument] of steps) await toolFinished(ports, { sessionId, note: STEP_NOTES[kind](argument) });
  return turnEnded(ports, { sessionId, reason: 'answer', answer, model, projectDir });
}

/** A turn that fixes an error: the check fails, a file is edited, the same check passes. */
export const fixTurn = (ports, sessionId, options = {}) =>
  turnOf(ports, sessionId, { steps: [['fail', 'npm test'], ['edit', '/proj/lib/redis.js'], ['pass', 'npm test 2>&1 | tail -5']], answer: 'Fixed the retries.', ...options });

/** A routine turn of work: one edit and a passing check. */
export const changeTurn = (ports, sessionId, index = 1, options = {}) =>
  turnOf(ports, sessionId, { prompt: `step ${index} of the retry work`, steps: [['edit', `/proj/lib/step${index}.js`], ['pass', 'npm test']], ...options });

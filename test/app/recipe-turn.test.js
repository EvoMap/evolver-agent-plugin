import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCommand } from '../../lib/app/commands/index.js';
import { adoptStrategy, lastTurnOf, promptSubmitted, takeWaitingStrategy } from '../../lib/app/prompt.js';
import { toolFinished } from '../../lib/app/tool-result.js';
import { turnEnded } from '../../lib/app/turn-end.js';
import { listedIdsOf, sessionOf } from '../../lib/session/state.js';
import { endedTurnSummaryOf } from '../../lib/turn-summary.js';
import { PROMPT, RECIPE, RECIPE_STEPS, memoryPorts } from './memory-ports.js';

const STEP_IDS = ['sha256:step1', 'sha256:step2'];
const WAIT = { waitMs: 5_000 };

const withRecipe = () => memoryPorts({ recipes: [RECIPE], stepAssets: RECIPE_STEPS });
const sessionIn = async (ports) => sessionOf(await ports.sessions.read('s1'));
const end = (ports) => turnEnded(ports, { sessionId: 's1', reason: 'answer', answer: 'Fixed.', projectDir: '/proj' });

test('a recalled Recipe books each step under its own text, and the turn keeps the whole Recipe as its strategy', async () => {
  const { ports } = withRecipe();
  const { injection } = await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  assert.match(injection, /^\[Evolution Memory\] Recipe: Stabilise flaky redis connection retries \(EvoMap network, 2 steps, in order\):/);
  assert.ok(injection.endsWith('Follow the steps in order. Apply them where they fit.'));
  const { injected } = await sessionIn(ports);
  assert.deepEqual(Object.keys(injected), STEP_IDS);
  assert.equal(injected['sha256:step2'].strategyText, '[Evolution Memory] Close the redis client (EvoMap network):\n1. Close the connection in the global teardown hook');
  assert.equal((await lastTurnOf(ports, 's1')).strategy, injection);
});

test('each step of a Recipe is reported on its own under the turn\'s task id, and its correction too', async () => {
  const { ports, queued } = withRecipe();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  await toolFinished(ports, { sessionId: 's1', note: { kind: 'shell', command: 'npm test', exit: 0, output: 'ℹ pass 3\nℹ fail 0' } });
  const ended = await end(ports);
  assert.deepEqual(ended.reports.map((report) => [report.asset_id, report.task_id, report.outcome]), STEP_IDS.map((id) => [id, 'testagent:s1:1', 'success']));
  assert.match(endedTurnSummaryOf(ended, { reason: 'answer' }), /reused EvoMap strategy "Unbound redis retries", "Close the redis client"/);
  await promptSubmitted(ports, { sessionId: 's1', prompt: '还是报错', ...WAIT });
  const corrections = queued.filter(({ report }) => report.task_id.endsWith(':correction'));
  assert.deepEqual(corrections.map(({ report }) => [report.asset_id, report.outcome]), STEP_IDS.map((id) => [id, 'failed']));
});

test('a Recipe the session booked is not offered again, nor are its steps fetched again', async () => {
  const { ports, requests } = withRecipe();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  await end(ports);
  const { injection } = await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  assert.match(injection, /^\[Evolution Memory\] Fix flaky Redis connection retries \(EvoMap network\):/);
  assert.equal(requests.filter((request) => request.body?.asset_ids).length, 1);
});

test('a late Recipe, once shown, keeps every step out of later recalls, and joining the turn books every step', async () => {
  const { ports } = withRecipe();
  const { late } = await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, waitMs: 0, keepLate: true });
  const landed = await late;
  assert.equal(await landed.show(), true);
  assert.deepEqual([...listedIdsOf(await sessionIn(ports))], STEP_IDS);
  assert.equal(await landed.join(), true);
  assert.deepEqual(Object.keys((await sessionIn(ports)).injected), STEP_IDS);
});

test('a searched Recipe adopted into the turn books every step for its end to report', async () => {
  const { ports } = withRecipe();
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'explain the build', ...WAIT });
  const searched = await runCommand(ports, { sessionId: 's1', name: 'evolver-search', args: 'flaky redis connection retries in tests' });
  await adoptStrategy(ports, { sessionId: 's1', strategy: searched.strategy });
  assert.deepEqual((await end(ports)).reports.map((report) => report.asset_id), STEP_IDS);
});

test('a Recipe held for the first tool result books every step there, not only the first', async () => {
  const { ports } = withRecipe();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT, holdForToolResult: true });
  assert.deepEqual(Object.keys((await sessionIn(ports)).injected), [], 'nothing is booked before a tool result');
  const text = await takeWaitingStrategy(ports, { sessionId: 's1' });
  assert.match(text, /^\[Evolution Memory\] Recipe: /);
  assert.deepEqual(Object.keys((await sessionIn(ports)).injected), STEP_IDS);
});

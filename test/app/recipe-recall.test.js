import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCommand } from '../../lib/app/commands/index.js';
import { adoptStrategy, lastTurnOf, promptSubmitted, takeWaitingStrategy } from '../../lib/app/prompt.js';
import { toolFinished } from '../../lib/app/tool-result.js';
import { turnEnded } from '../../lib/app/turn-end.js';
import { sessionOf } from '../../lib/session/state.js';
import { endedTurnSummaryOf } from '../../lib/turn-summary.js';
import { ASSET, PROMPT, memoryPorts } from './memory-ports.js';

const WAIT = { waitMs: 5_000 };
const RETRIES = 'sha256:' + 'b'.repeat(64);
const TEARDOWN = 'sha256:' + 'c'.repeat(64);
const RECIPE = {
  id: 'rcp_redis',
  title: 'Stabilise flaky Redis connections in tests',
  description: 'Unbound the retries, then close the connection after the suite',
  steps: [{ asset_id: TEARDOWN, asset_type: 'Gene', position: 2 }, { asset_id: RETRIES, asset_type: 'Gene', position: 1 }],
};
const STEP_ASSETS = [
  { asset_id: RETRIES, short_title: 'Unbound redis retries', strategy: ['Set `maxRetriesPerRequest` to null in lib/redis.js', 'Run npm test'] },
  { asset_id: TEARDOWN, short_title: 'Close redis after the suite', strategy: ['Close the connection in the global teardown hook'] },
];

const recipePorts = () => memoryPorts({ recipes: [RECIPE], stepAssets: STEP_ASSETS });
const injectedOf = async (ports, sessionId) => sessionOf(await ports.sessions.read(sessionId)).injected;

async function checkedTurn(ports, sessionId) {
  const opened = await promptSubmitted(ports, { sessionId, prompt: PROMPT, turnId: 't1', ...WAIT });
  await toolFinished(ports, { sessionId, note: { kind: 'shell', command: 'npm test', exit: 0, output: 'ℹ pass 3\nℹ fail 0' } });
  return opened;
}

const end = (ports, sessionId) => turnEnded(ports, { sessionId, reason: 'answer', answer: 'Fixed.', projectDir: '/proj' });

test('a recalled Recipe books each step under its own strategy, and its turn end reports every step', async () => {
  const { ports } = recipePorts();
  const { injection } = await checkedTurn(ports, 's1');
  assert.match(injection, /^\[Evolution Memory\] Recipe: Stabilise flaky Redis connections in tests \(EvoMap network, 2 steps, in order\):\n\nStep 1 — Unbound redis retries:/);
  assert.ok(injection.endsWith('\n\nApply them where they fit.'));
  const injected = await injectedOf(ports, 's1');
  assert.deepEqual(Object.keys(injected), [RETRIES, TEARDOWN], 'the single strategy is not booked beside it');
  assert.equal(injected[TEARDOWN].strategyText, '[Evolution Memory] Close redis after the suite (EvoMap network):\n1. Close the connection in the global teardown hook');

  const ended = await end(ports, 's1');
  assert.deepEqual(ended.reports.map((report) => [report.asset_id, report.task_id, report.outcome]), [
    [RETRIES, 'testagent:s1:1', 'success'],
    [TEARDOWN, 'testagent:s1:1', 'success'],
  ]);
  assert.match(endedTurnSummaryOf(ended, { reason: 'answer' }), /reused EvoMap strategy "Unbound redis retries", "Close redis after the suite"/);
});

test('a Recipe\'s steps stay out of the session\'s later recalls, which fall back to a single strategy', async () => {
  const { ports, requests } = recipePorts();
  await checkedTurn(ports, 's1');
  await end(ports, 's1');
  const { injection } = await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...WAIT });
  assert.match(injection, /^\[Evolution Memory\] Fix flaky Redis connection retries \(EvoMap network\):/);
  assert.deepEqual(Object.keys(await injectedOf(ports, 's1')), [RETRIES, TEARDOWN, ASSET.asset_id]);
  assert.equal(requests.filter((request) => request.body?.asset_ids).length, 1, 'its steps are not fetched again');
});

test('the open turn replays the whole Recipe for a host whose injection lasts one model call', async () => {
  const { ports } = recipePorts();
  const { injection } = await checkedTurn(ports, 's1');
  assert.equal((await lastTurnOf(ports, 's1')).strategy, injection);
});

test('a Recipe that lands late is shown and joins its turn with every step', async () => {
  const { ports } = recipePorts();
  const { late } = await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, waitMs: 0, keepLate: true });
  const landed = await late;
  assert.match(landed.text, /^\[Evolution Memory\] Recipe: /);
  assert.equal(await landed.show(), true);
  assert.deepEqual(sessionOf(await ports.sessions.read('s1')).shown, [RETRIES, TEARDOWN]);
  assert.equal(await landed.join(), true);
  assert.deepEqual(Object.keys(await injectedOf(ports, 's1')), [RETRIES, TEARDOWN]);
});

test('a searched Recipe is adopted step by step, so the turn end reports each step', async () => {
  const { ports } = recipePorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'explain the build', ...WAIT });
  const searched = await runCommand(ports, { sessionId: 's1', name: 'evolver-search', args: PROMPT });
  assert.match(searched.text, /^\[Evolution Memory\] Recipe: /);
  await adoptStrategy(ports, { sessionId: 's1', strategy: searched.strategy });
  const { reports } = await end(ports, 's1');
  assert.deepEqual(reports.map((report) => report.asset_id), [RETRIES, TEARDOWN]);
});

test('a Recipe held for the turn\'s first tool result is taken whole and books every step', async () => {
  const { ports } = recipePorts();
  const { injection } = await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, holdForToolResult: true, ...WAIT });
  assert.equal(injection, '');
  assert.deepEqual(sessionOf(await ports.sessions.read('s1')).waiting.ids, [RETRIES, TEARDOWN]);
  assert.match(await takeWaitingStrategy(ports, { sessionId: 's1' }), /^\[Evolution Memory\] Recipe: /);
  const injected = await injectedOf(ports, 's1');
  assert.deepEqual(Object.keys(injected), [RETRIES, TEARDOWN]);
  assert.match(injected[RETRIES].strategyText, /^\[Evolution Memory\] Unbound redis retries \(EvoMap network\):/);
});

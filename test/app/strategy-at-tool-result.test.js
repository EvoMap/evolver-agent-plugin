import assert from 'node:assert/strict';
import { test } from 'node:test';

import { promptSubmitted, takeWaitingStrategy } from '../../lib/app/prompt.js';
import { sessionEnded } from '../../lib/app/session-end.js';
import { toolFinished } from '../../lib/app/tool-result.js';
import { turnEnded } from '../../lib/app/turn-end.js';
import { ASSET, PROMPT, memoryPorts } from './memory-ports.js';

// A host whose prompt hook cannot add context (Grok) holds the recalled strategy for the turn's first tool result.

const HELD = { waitMs: 5_000, holdForToolResult: true };
const end = (ports, sessionId) => turnEnded(ports, { sessionId, reason: 'answer', answer: 'Fixed.', projectDir: '/proj' });
const passingCheck = { kind: 'shell', command: 'npm test', exit: 0, output: 'ℹ pass 3\nℹ fail 0' };

test('a held strategy is no injection at the prompt; the first tool result takes it once and its turn end reports it', async () => {
  const { ports, queued } = memoryPorts();
  const { injection } = await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...HELD });
  assert.equal(injection, '');
  assert.deepEqual((await ports.sessions.read('s1')).injected, {}, 'nothing is booked before the model sees it');
  const taken = await takeWaitingStrategy(ports, { sessionId: 's1' });
  assert.match(taken, /^\[Evolution Memory\] Fix flaky Redis connection retries[\s\S]*Apply them where they fit\.$/);
  assert.equal(await takeWaitingStrategy(ports, { sessionId: 's1' }), '', 'a later tool result of the turn gets nothing');
  await toolFinished(ports, { sessionId: 's1', note: passingCheck });
  const ended = await end(ports, 's1');
  assert.deepEqual(ended.reports.map((report) => [report.asset_id, report.task_id, report.outcome]), [[ASSET.asset_id, 'testagent:s1:1', 'success']]);
  assert.equal(queued.length, 1);
});

test('a turn that ends before any tool result drops its strategy unbooked: no report, and the next recall may offer it', async () => {
  const { ports, queued } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...HELD });
  const ended = await end(ports, 's1');
  assert.deepEqual(ended.reports, []);
  assert.equal(await takeWaitingStrategy(ports, { sessionId: 's1' }), '', 'its turn is over');
  assert.deepEqual(queued, []);
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...HELD });
  assert.match(await takeWaitingStrategy(ports, { sessionId: 's1' }), /Fix flaky Redis connection retries/, 'it was never kept out of recalls');
});

test('a new prompt drops the last turn\'s waiting strategy, so a late tool result of that turn books nothing', async () => {
  const { ports } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...HELD });
  await promptSubmitted(ports, { sessionId: 's1', prompt: 'thanks, that is all', ...HELD });
  assert.equal(await takeWaitingStrategy(ports, { sessionId: 's1' }), '');
  assert.deepEqual((await ports.sessions.read('s1')).injected, {});
});

test('a session end with a strategy still waiting reports nothing for it', async () => {
  const { ports, queued } = memoryPorts();
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, ...HELD });
  await sessionEnded(ports, { sessionId: 's1', projectDir: '/proj' });
  assert.deepEqual(queued, []);
  assert.equal((await ports.sessions.read('s1')).waiting, null);
});

test('without holdForToolResult nothing ever waits, and a tool result takes nothing', async () => {
  const { ports } = memoryPorts();
  const { injection } = await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, waitMs: 5_000 });
  assert.match(injection, /Fix flaky Redis connection retries/);
  assert.equal(await takeWaitingStrategy(ports, { sessionId: 's1' }), '');
});

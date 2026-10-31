import assert from 'node:assert/strict';
import { test } from 'node:test';

import { promptSubmitted } from '../../lib/app/prompt.js';
import { recallWhenStuck } from '../../lib/app/stuck-recall.js';
import { toolFinished } from '../../lib/app/tool-result.js';
import { turnEnded } from '../../lib/app/turn-end.js';
import { ASSET, PROMPT, memoryPorts } from './memory-ports.js';

const EDIT = { kind: 'edit', paths: ['/proj/lib/redis.js'], lines: 1, identifiers: ['maxRetriesPerRequest'] };
const failedCheck = (output) => ({ kind: 'shell', command: 'npm test', exit: 1, output });
const FAILED = failedCheck('✖ retries test\nAssertionError: expected 3 to equal null');
const stuckFetches = (requests) => requests.filter((request) => request.path === '/asset/fetch' && request.body.context?.trigger === 'check_failed');

async function stuckTurn(ports) {
  await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, waitMs: 0 });
  await toolFinished(ports, { sessionId: 's1', note: EDIT });
}

async function stuck(ports, note) {
  await toolFinished(ports, { sessionId: 's1', note });
  return recallWhenStuck(ports, { sessionId: 's1', note, waitMs: 5_000 });
}

test('a failed check recalls for what it printed, with the task and language as context, and the turn reports it', async () => {
  const { ports, requests } = memoryPorts();
  await stuckTurn(ports);

  const strategy = await stuck(ports, FAILED);

  assert.match(strategy, /^\[Evolution Memory\] Fix flaky Redis connection retries[\s\S]*Apply them where they fit\.$/);
  assert.deepEqual(stuckFetches(requests).at(-1).body, {
    text: 'changed: maxRetriesPerRequest | AssertionError: expected 3 to equal null | files: redis.js',
    context: { task: PROMPT, trigger: 'check_failed', language: ['JavaScript'] },
  });
  const ended = await turnEnded(ports, { sessionId: 's1', reason: 'answer', answer: 'Fixed.', projectDir: '/proj' });
  assert.deepEqual(ended.reports.map((report) => report.asset_id), [ASSET.asset_id]);
});

test('a turn recalls once per distinct failure and for two failures at most', async () => {
  const { ports, requests } = memoryPorts();
  await stuckTurn(ports);
  await stuck(ports, FAILED);
  await stuck(ports, FAILED);
  await stuck(ports, failedCheck('TypeError: client.quit is not a function'));
  await stuck(ports, failedCheck('Error: connect ECONNREFUSED 127.0.0.1:6379'));
  assert.equal(stuckFetches(requests).length, 2);
});

test('a passing check, a non-check, an error-free failure, a command turn or recall turned off recalls nothing', async () => {
  const cases = [
    [{ kind: 'shell', command: 'npm test', exit: 0, output: 'ℹ pass 3\nℹ fail 0' }],
    [{ kind: 'shell', command: 'ls missing', exit: 2, output: 'ls: missing: No such file or directory' }],
    [failedCheck('Killed')],
    [FAILED, { settings: { recall: false } }],
    [FAILED, { isCommand: true }],
  ];
  for (const [note, { settings, isCommand = false } = {}] of cases) {
    const { ports, requests } = memoryPorts();
    if (settings) ports.settings = settings;
    await promptSubmitted(ports, { sessionId: 's1', prompt: PROMPT, waitMs: 0, isCommand });
    assert.equal(await stuck(ports, note), '');
    assert.equal(stuckFetches(requests).length, 0, JSON.stringify(note));
  }
});

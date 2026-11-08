import assert from 'node:assert/strict';
import { test } from 'node:test';

import { promptSubmitted } from '../../lib/app/prompt.js';
import { PROMPT, RECIPE, memoryPorts } from './memory-ports.js';

function harness() {
  const { ports } = memoryPorts();
  const timers = [], requests = [];
  ports.clock.sleep = (ms, signal) => new Promise((resolve) => {
    timers.push({ ms, signal, resolve });
    signal.addEventListener('abort', resolve, { once: true });
  });
  const request = ports.proxy.request;
  ports.proxy.request = async (method, path, body, { signal }) => {
    requests.push({ path, signal });
    return request(method, path, body);
  };
  return { ports, timers, requests };
}

test('finished recall cancels its timers without aborting completed HTTP requests', async () => {
  const { ports, timers, requests } = harness();
  const { injection } = await promptSubmitted(ports, { sessionId: 's', prompt: PROMPT, waitMs: 5_000 });
  assert.match(injection, /Evolution Memory/);
  assert.equal(timers.length, 2);
  assert.ok(timers.every(({ signal }) => signal.aborted));
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ signal }) => !signal.aborted));
});

test('a recall that misses the hook deadline aborts only its outstanding work', async () => {
  const { ports, timers } = harness();
  const requests = [];
  ports.proxy.request = (_method, path, _body, { signal }) => new Promise((resolve) => {
    requests.push(signal);
    signal.addEventListener('abort', () => resolve(path === '/recipe/search' ? { ok: true, data: [RECIPE] } : { ok: false }), { once: true });
  });
  const opened = promptSubmitted(ports, { sessionId: 's', prompt: PROMPT, waitMs: 5_000 });
  while (timers.length < 2) await new Promise(setImmediate);
  timers.find(({ ms }) => ms === 5_000).resolve();
  assert.equal((await opened).injection, '');
  await new Promise(setImmediate);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((signal) => signal.aborted));
  assert.ok(timers.every(({ signal }) => signal.aborted));
});

test('late recall keeps its requests alive until the strategy lands, then cancels its timer', async () => {
  const { ports, timers, requests } = harness();
  const request = ports.proxy.request;
  const ready = Promise.withResolvers();
  ports.proxy.request = async (...args) => { await ready.promise; return request(...args); };
  const { injection, late } = await promptSubmitted(ports, { sessionId: 's', prompt: PROMPT, waitMs: 0, keepLate: true });
  assert.equal(injection, '');
  assert.ok(timers.every(({ signal }) => !signal.aborted));
  ready.resolve();
  assert.match((await late).text, /Evolution Memory/);
  assert.ok(requests.every(({ signal }) => !signal.aborted));
  assert.ok(timers.every(({ signal }) => signal.aborted));
});

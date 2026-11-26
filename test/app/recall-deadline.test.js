import assert from 'node:assert/strict';
import { test } from 'node:test';

import { promptSubmitted } from '../../lib/app/prompt.js';
import { recallRequestOf } from '../../lib/app/recall-request.js';
import { PROMPT, RECIPE, RECIPE_STEPS, memoryPorts } from './memory-ports.js';

function harness(options) {
  const { ports } = memoryPorts(options);
  const timers = [], requests = [];
  ports.clock.sleep = (ms, signal) => new Promise((resolve) => {
    timers.push({ ms, signal, resolve });
    signal.addEventListener('abort', resolve, { once: true });
  });
  const request = ports.proxy.request;
  ports.proxy.request = async (method, path, body, { signal, timeoutMs }) => {
    requests.push({ path, body, signal, timeoutMs });
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

test('a blocking recall forwards the hook budget to Recipe search, text recall and Recipe step fetch', async () => {
  const { ports, requests } = harness({ recipes: [RECIPE], stepAssets: RECIPE_STEPS });
  const waitMs = 9_832.4;
  const { injection } = await promptSubmitted(ports, { sessionId: 's', prompt: PROMPT, waitMs });
  assert.match(injection, /Unbound redis retries/);
  assert.deepEqual(requests.map(({ path }) => path), ['/recipe/search', '/asset/fetch', '/asset/fetch']);
  assert.ok(requests[2].body.asset_ids.length > 0);
  for (const { body, timeoutMs } of requests) {
    assert.equal(body.timeout_ms, 9_833);
    assert.equal(timeoutMs, waitMs);
  }
});

test('a positive Hub budget is clamped without changing the local transport budget', async () => {
  const body = { text: PROMPT };
  for (const [waitMs, expected] of [[25.5, 100], [45_000, 30_000]]) {
    const proxy = { request(_method, _path, payload, { timeoutMs }) {
      assert.deepEqual(payload, { ...body, timeout_ms: expected });
      assert.equal(timeoutMs, waitMs);
      return { ok: true };
    } };
    const recall = recallRequestOf(proxy, { timeoutMs: waitMs });
    assert.equal((await recall.request('POST', '/asset/fetch', body)).ok, true);
  }
  assert.equal(Object.hasOwn(body, 'timeout_ms'), false);
});

test('a recall that may still answer late keeps the Proxy default per request', async () => {
  const { ports, requests } = harness();
  const { late } = await promptSubmitted(ports, { sessionId: 's', prompt: PROMPT, waitMs: 0, keepLate: true });
  await late;
  assert.ok(requests.length > 0);
  assert.ok(requests.every(({ body, timeoutMs }) => timeoutMs === undefined && !Object.hasOwn(body, 'timeout_ms')));
});

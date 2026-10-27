import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createModelQueue } from '../../lib/channels/relay/model-queue.js';
import { createRelay } from '../../lib/channels/relay/server.js';
import claudeCode from '../../hosts/claude-code/profile.js';
import { PROMPT } from '../app/memory-ports.js';
import { fakeProxy } from '../helpers/fake-proxy.js';

const RELAY = fileURLToPath(new URL('../../bin/relay.mjs', import.meta.url));

async function started(t, { delays } = {}) {
  const proxy = await fakeProxy({ delays });
  const relay = createRelay({ profile: claudeCode, env: proxy.env });
  const port = await relay.listen();
  t.after(() => {
    relay.close();
    proxy.close();
  });
  const post = async (path, body = {}, token = relay.token) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { post, proxy, port, relay };
}

test('the relay answers only the module holding its token, on the routes it serves, and survives a bad body', async (t) => {
  const { post, port, relay } = await started(t);
  assert.equal((await post('/model/next', { waitMs: 10 }, 'wrong')).status, 401);
  assert.equal((await post('/nowhere')).status, 404);
  const bad = await fetch(`http://127.0.0.1:${port}/event`, { method: 'POST', headers: { Authorization: `Bearer ${relay.token}` }, body: '{not json' });
  assert.equal(bad.status, 500);
  assert.deepEqual((await post('/model/next', { waitMs: 10 })).body, null);
});

test('a turn\'s recall answers later, by id; the strategy is joined to its turn once, while it is open', async (t) => {
  const { post } = await started(t);
  const turn = { session_id: 's1', cwd: '/proj', turn_id: 't1', text: PROMPT, origin: { kind: 'composer' } };
  const { body: answer } = await post('/event', { hostEvent: 'turn.start', payload: turn });
  assert.equal(answer.append, undefined);
  const { body: landed } = await post('/late', { id: answer.late });
  assert.match(landed.text, /^\[Evolution Memory\] Fix flaky Redis connection retries/);
  assert.deepEqual((await post('/late/join', { id: landed.id })).body, { joined: true });
  assert.deepEqual((await post('/late/join', { id: landed.id })).body, { joined: false });
  assert.deepEqual((await post('/event', { hostEvent: 'no.such.event', payload: turn })).body, {});
});

test('a model request waits for the module, which answers it by id; an abandoned one is withdrawn', async () => {
  const queue = createModelQueue();
  const completion = queue.port.complete('claude-haiku-5-5', 'distill this', new AbortController().signal);
  const request = await queue.next(1_000);
  assert.deepEqual([request.model, request.prompt], ['claude-haiku-5-5', 'distill this']);
  assert.equal(queue.answer({ id: request.id, text: '{"skip":"nothing"}', usage: { input_tokens: 9 } }), true);
  assert.deepEqual(await completion, { answer: '{"skip":"nothing"}', usage: { input_tokens: 9 } });

  const stop = new AbortController();
  const abandoned = queue.port.complete('m', 'p', stop.signal);
  stop.abort(new Error('cancelled'));
  await assert.rejects(abandoned, /cancelled/);
  assert.equal(await queue.next(20), null);
  const failed = queue.port.complete('m', 'p', new AbortController().signal);
  queue.answer({ id: (await queue.next(1_000)).id, error: 'api-error' });
  await assert.rejects(failed, /api-error/);
});

test('the relay process serves only a relayed agent', () => {
  const refused = spawnSync(process.execPath, [RELAY, 'cursor'], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /"cursor" is not a relayed agent/);
});

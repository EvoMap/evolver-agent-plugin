import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createClineModel } from '../../../hosts/cline/dist/model.js';

const modelId = 'gpt-4o-mini';
const fixtureKey = 'cline-fixture-account-a';
const prompt = 'Write a reusable Recipe from the passed retry-budget check.';
const answer = '{"skip":"routine work"}';
const completion = (res, { model = modelId, finishReason = 'stop', message = {} } = {}) =>
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    id: 'chatcmpl-fixture', object: 'chat.completion', model, choices: [{
      index: 0, finish_reason: finishReason, message: { role: 'assistant', content: answer, ...message },
    }],
    usage: { prompt_tokens: 16, completion_tokens: 6, total_tokens: 22 },
  }));

async function endpoint(t, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, path: req.url, auth: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    respond(res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((done) => { server.close(done); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

function clineFixture(t, baseUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-cline-distill-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const path = join(dir, 'providers.json');
  const processStart = Date.now() + 60_000;
  const fileTime = new Date(processStart - 120_000);
  const env = { CLINE_SESSION_BACKEND_MODE: 'local', CLINE_PROVIDER_SETTINGS_PATH: path };
  const writeSettings = ({
    apiKey = fixtureKey, provider = 'openai-compatible', model = modelId,
    tokenSource = 'manual', version = 1, modes = {}, modifiedAt = fileTime,
  } = {}) => {
    writeFileSync(path, JSON.stringify({ version, lastUsedProvider: provider, modes, providers: {
      [provider]: { settings: { provider, apiKey, baseUrl, model }, tokenSource },
    } }));
    utimesSync(path, modifiedAt, modifiedAt);
  };
  writeSettings();
  return { model: createClineModel({ env, startedAt: () => processStart }), writeSettings, processStart };
}

test('Cline distills on the captured endpoint, provider model and account using only the private model prompt', async t => {
  const server = await endpoint(t, completion);
  const { model } = clineFixture(t, server.url);
  const route = await model.capture();
  assert.deepEqual(route?.selection, { providerId: 'openai-compatible', modelId });
  assert.equal(typeof route.configDigest, 'string');
  assert.equal(JSON.stringify(route).includes(fixtureKey), false);

  const result = await model.complete(route, prompt, AbortSignal.timeout(2_000));
  assert.equal(result.answer, answer);
  assert.deepEqual(result.usage, { inputTokens: 16, outputTokens: 6 });
  const [request] = server.requests;
  assert.equal(server.requests.length, 1);
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/chat/completions');
  assert.equal(request.auth, 'Bearer ' + fixtureKey);
  assert.equal(request.body.model, modelId);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: prompt }]);
  assert.ok(request.body.tools === undefined || request.body.tools.length === 0);
  assert.equal(request.body.conversation, undefined);
  assert.equal(request.body.store, false);
  assert.equal(request.body.stream, false);
});

test('Cline refuses changed model or credentials before sending the distillation prompt', async t => {
  const server = await endpoint(t, completion);
  const { model, writeSettings } = clineFixture(t, server.url);
  const captured = await model.capture();
  assert.ok(captured);
  for (const change of [{ apiKey: 'cline-fixture-account-b' }, { model: 'gpt-4o' }]) {
    writeSettings(change);
    await assert.rejects(() => model.complete(captured, prompt, AbortSignal.timeout(2_000)), { code: 'MODEL_UNAVAILABLE' });
  }
  assert.deepEqual(server.requests, []);
});

test('Cline skips unsupported settings and files written after its native process started', async t => {
  const server = await endpoint(t, completion);
  const { model, writeSettings, processStart } = clineFixture(t, server.url);
  for (const invalid of [
    { provider: 'cline', tokenSource: 'oauth' },
    { tokenSource: 'oauth' },
    { version: 2 },
    { modes: { act: { provider: 'openai-compatible', model: 'gpt-4o' } } },
    { modifiedAt: new Date(processStart + 1_000) },
  ]) {
    writeSettings(invalid);
    assert.equal(await model.capture(), null);
  }
  assert.deepEqual(server.requests, []);
});

test('Cline discards a completion when the captured route changes in flight', async t => {
  const requested = Promise.withResolvers();
  const server = await endpoint(t, (res) => requested.resolve(res));
  const { model, writeSettings } = clineFixture(t, server.url);
  const route = await model.capture();
  assert.ok(route);
  const pending = model.complete(route, prompt, AbortSignal.timeout(2_000));
  const rejected = assert.rejects(pending, { code: 'MODEL_UNAVAILABLE', reason: 'route_changed' });
  const response = await Promise.race([requested.promise, pending.then(() => assert.fail('completion returned before HTTP dispatch'))]);
  writeSettings({ apiKey: 'cline-fixture-account-b' });
  completion(response);
  await rejected;
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].auth, 'Bearer ' + fixtureKey);
});

test('Cline will not follow a redirect to another endpoint', async t => {
  const target = await endpoint(t, completion);
  const redirect = await endpoint(t, (res) => res.writeHead(307, {
    location: `${target.url}/chat/completions`,
  }).end());
  const { model } = clineFixture(t, redirect.url);
  const route = await model.capture();
  assert.ok(route);

  await assert.rejects(() => model.complete(route, prompt, AbortSignal.timeout(2_000)));
  assert.equal(redirect.requests.length, 1);
  assert.deepEqual(target.requests, []);
});

test('Cline rejects replies from another model, truncated text and model tool calls', async t => {
  let reply;
  const server = await endpoint(t, (res) => completion(res, reply));
  const { model } = clineFixture(t, server.url);
  const route = await model.capture();
  assert.ok(route);
  for (const invalid of [
    { model: 'gpt-4o' },
    { finishReason: 'length' },
    { message: { tool_calls: [{ id: 'tool-fixture', type: 'function', function: { name: 'shell' } }] } },
  ]) {
    reply = invalid;
    await assert.rejects(() => model.complete(route, prompt, AbortSignal.timeout(2_000)));
  }
  assert.equal(server.requests.length, 3);
});

test('Cline stops a pending completion and closes the HTTP response on abort', async t => {
  const requestClosed = Promise.withResolvers();
  const requested = Promise.withResolvers();
  const server = await endpoint(t, (res) => {
    res.once('close', () => requestClosed.resolve());
    requested.resolve();
  });
  const { model } = clineFixture(t, server.url);
  const route = await model.capture();
  assert.ok(route);
  const stopping = new AbortController();
  const pending = model.complete(route, prompt, AbortSignal.any([stopping.signal, AbortSignal.timeout(2_000)]));
  const rejected = assert.rejects(pending);

  await Promise.race([requested.promise, pending.then(() => assert.fail('completion returned before HTTP dispatch'))]);
  stopping.abort();
  await rejected;
  await requestClosed.promise;
  assert.equal(server.requests.length, 1);
});

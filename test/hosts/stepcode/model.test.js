import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stepModel } from '../../../hosts/stepcode/dist/model.js';

function nativeContext() {
  const calls = [];
  const reply = {
    role: 'assistant', provider: 'fixture', model: 'fixture-model', api: 'openai-responses',
    stopReason: 'stop', content: [{ type: 'text', text: '{"gene":"private"}' }],
    usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
  };
  const provider = { id: 'fixture', streamSimple(model, context, options) {
    calls.push({ model, context, options });
    return { result: async () => reply };
  } };
  const auth = { ok: true, apiKey: 'private-fixture-key', headers: { 'X-Account': 'private-account' }, env: { REGION: 'fixture' } };
  const ctx = {
    model: { id: 'fixture-model', provider: 'fixture', api: 'openai-responses', baseUrl: 'https://fixture.example/v1', reasoning: true },
    thinkingLevel: 'high',
    modelRegistry: {
      getProvider: () => provider,
      getApiKeyAndHeaders: async () => auth,
      complete: () => { throw new Error('Must use the captured provider, not the mutable registry'); },
    },
  };
  return { ctx, calls, provider, auth, reply };
}

test('Step completion uses the captured SDK route and variant without tools, session context or persisted credentials', async () => {
  const { ctx, calls } = nativeContext();
  const runner = stepModel();
  const descriptor = await runner.captureContext(ctx);
  assert.equal(runner.capture, true);
  assert.equal(runner.configStamp(), descriptor.configDigest);
  assert.deepEqual(descriptor.selection, { providerId: 'fixture', modelId: 'fixture-model', variant: 'high' });
  assert.doesNotMatch(JSON.stringify(descriptor), /private-fixture-key|private-account|fixture\.example|REGION/);
  assert.deepEqual(await runner.complete(descriptor, 'Distill only this verified range'), {
    answer: '{"gene":"private"}', usage: { inputTokens: 12, outputTokens: 3 },
  });
  assert.equal(calls.length, 1);
  const { model, context, options } = calls[0];
  assert.deepEqual(model, ctx.model);
  assert.equal(context.messages.length, 1);
  assert.deepEqual(context.messages[0].content, [{ type: 'text', text: 'Distill only this verified range' }]);
  assert.deepEqual(context.tools, []);
  assert.equal(context.systemPrompt, undefined);
  assert.equal(options.apiKey, 'private-fixture-key');
  assert.deepEqual(options.headers, { 'X-Account': 'private-account' });
  assert.deepEqual(options.env, { REGION: 'fixture' });
  assert.equal(options.reasoning, 'high');
  assert.equal(options.maxTokens, 1_024);
  assert.equal(options.toolChoice, 'none');
  assert.equal(options.cacheRetention, 'none');
  assert.equal(options.sessionId, undefined);
  assert.equal(options.signal.aborted, false);
  runner.clear();
});

test('Step rejects a changed account, route, model, variant or provider before sending a completion', async () => {
  const edits = [
    (fixture) => { fixture.auth.apiKey = 'other-account-key'; },
    (fixture) => { fixture.auth.baseUrl = 'https://other.example/v1'; },
    (fixture) => { fixture.auth.headers['X-Account'] = 'other-account'; },
    (fixture) => { fixture.auth.env.REGION = 'other-region'; },
    (fixture) => { fixture.ctx.model.id = 'other-model'; },
    (fixture) => { fixture.ctx.thinkingLevel = 'low'; },
    (fixture) => { fixture.ctx.modelRegistry.getProvider = () => ({ ...fixture.provider }); },
    (fixture) => { fixture.provider.streamSimple = () => { throw new Error('Replacement stream must not run'); }; },
  ];
  for (const edit of edits) {
    const fixture = nativeContext();
    const runner = stepModel();
    const descriptor = await runner.captureContext(fixture.ctx);
    edit(fixture);
    await assert.rejects(runner.complete(descriptor, 'Private range'), { code: 'MODEL_UNAVAILABLE', reason: 'route_changed' });
    assert.equal(fixture.calls.length, 0);
    runner.clear();
  }
});

test('a failed Step capture clears the old account binding and exposes no native credential error', async () => {
  const { ctx, calls } = nativeContext();
  const runner = stepModel();
  const descriptor = await runner.captureContext(ctx);
  ctx.modelRegistry.getApiKeyAndHeaders = async () => { throw new Error('private-fixture-key private-account'); };
  await assert.rejects(runner.captureContext(ctx), (error) => {
    assert.equal(error.code, 'MODEL_UNAVAILABLE');
    assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /private-fixture-key|private-account/);
    return true;
  });
  assert.equal(runner.configStamp(), null);
  await assert.rejects(runner.complete(descriptor, 'Private range'), { code: 'MODEL_UNAVAILABLE', reason: 'route_unresolved' });
  assert.equal(calls.length, 0);
});

test('Step cancellation and clear abort the native request and reject even a late successful SDK answer', async () => {
  for (const stop of ['clear', 'caller']) {
    const fixture = nativeContext();
    let finish;
    let started;
    let nativeSignal;
    const waiting = new Promise((resolve) => { started = resolve; });
    fixture.provider.streamSimple = (_model, _context, options) => {
      nativeSignal = options.signal;
      started();
      return { result: () => new Promise((resolve) => { finish = resolve; }) };
    };
    const runner = stepModel();
    const descriptor = await runner.captureContext(fixture.ctx);
    const stopping = new AbortController();
    const pending = runner.complete(descriptor, 'Private range', stopping.signal);
    await waiting;
    let timer;
    try {
      if (stop === 'clear') runner.clear(); else stopping.abort();
      assert.equal(nativeSignal.aborted, true, stop);
      await assert.rejects(Promise.race([pending, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Cancellation waited for the SDK answer')), 500);
      })]), { name: 'AbortError' });
    } finally {
      clearTimeout(timer);
      finish(fixture.reply);
      await pending.catch(() => {});
      runner.clear();
    }
  }
});

test('Step SDK failures cannot copy provider credentials into persisted errors', async () => {
  const fixture = nativeContext();
  fixture.provider.streamSimple = () => ({ result: async () => {
    throw Object.assign(new Error('Authorization private-fixture-key'), { cause: new Error('private-account'), debug: fixture.auth });
  } });
  const runner = stepModel();
  const descriptor = await runner.captureContext(fixture.ctx);
  await assert.rejects(runner.complete(descriptor, 'Private range'), (error) => {
    assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /private-fixture-key|private-account|Authorization/);
    assert.equal(error.cause, undefined);
    return true;
  });
  runner.clear();
});

test('Step accepts only a bounded, complete text answer on the requested model', async () => {
  const edits = [
    (reply) => { reply.role = 'user'; },
    (reply) => { reply.provider = 'other-provider'; },
    (reply) => { reply.model = 'other-model'; },
    (reply) => { reply.api = 'other-api'; },
    (reply) => { reply.stopReason = 'length'; },
    (reply) => { reply.stopReason = 'aborted'; },
    (reply) => { reply.content.push({ type: 'toolCall', name: 'bash', arguments: {} }); },
    (reply) => { reply.content = [{ type: 'text', text: { secret: 'private-fixture-key' } }]; },
    (reply) => { reply.content = [{ type: 'text', text: ' ' }]; },
    (reply) => { reply.content = [{ type: 'text', text: 'x'.repeat(1_048_577) }]; },
  ];
  for (const edit of edits) {
    const fixture = nativeContext();
    edit(fixture.reply);
    const runner = stepModel();
    const descriptor = await runner.captureContext(fixture.ctx);
    await assert.rejects(runner.complete(descriptor, 'Private range'), /Step Code returned no complete answer/);
    runner.clear();
  }
  const fixture = nativeContext();
  fixture.reply.content.unshift({ type: 'thinking', thinking: 'Private reasoning is not an answer' });
  fixture.reply.usage.private = 'private-fixture-key';
  const runner = stepModel();
  const descriptor = await runner.captureContext(fixture.ctx);
  assert.deepEqual(await runner.complete(descriptor, 'Private range'), {
    answer: '{"gene":"private"}', usage: { inputTokens: 12, outputTokens: 3 },
  });
  runner.clear();
});

test('Step cannot accept an answer after its captured account changes during completion', async () => {
  const fixture = nativeContext();
  fixture.provider.streamSimple = () => ({ result: async () => {
    fixture.auth.apiKey = 'other-account-key';
    return fixture.reply;
  } });
  const runner = stepModel();
  const descriptor = await runner.captureContext(fixture.ctx);
  await assert.rejects(runner.complete(descriptor, 'Private range'), { code: 'MODEL_UNAVAILABLE', reason: 'route_changed' });
  runner.clear();
});

test('a stale concurrent Step capture cannot restore an older account', async () => {
  const old = nativeContext();
  let finish;
  old.ctx.modelRegistry.getApiKeyAndHeaders = () => new Promise((resolve) => { finish = resolve; });
  const current = nativeContext();
  current.auth.apiKey = 'current-account-key';
  const runner = stepModel();
  const pending = runner.captureContext(old.ctx);
  const descriptor = await runner.captureContext(current.ctx);
  finish(old.auth);
  await assert.rejects(pending, { code: 'MODEL_UNAVAILABLE', reason: 'route_changed' });
  assert.equal(runner.configStamp(), descriptor.configDigest);
  await runner.complete(descriptor, 'Current account range');
  assert.equal(old.calls.length, 0);
  assert.equal(current.calls[0].options.apiKey, 'current-account-key');
  runner.clear();
});

test('Step completion deadline aborts the SDK request without accepting its later answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = nativeContext();
  let finish;
  let started;
  let signal;
  const waiting = new Promise((resolve) => { started = resolve; });
  fixture.provider.streamSimple = (_model, _context, options) => {
    signal = options.signal;
    started();
    return { result: () => new Promise((resolve) => { finish = resolve; }) };
  };
  const runner = stepModel();
  const descriptor = await runner.captureContext(fixture.ctx);
  const pending = runner.complete(descriptor, 'Private range');
  await waiting;
  t.mock.timers.tick(90_000);
  assert.equal(signal.aborted, true);
  await assert.rejects(pending, { name: 'TimeoutError' });
  finish(fixture.reply);
  runner.clear();
});

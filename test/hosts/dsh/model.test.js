import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dshModel } from '../../../hosts/dsh/dist/model.js';

const ROUTE = { provider: 'deepseek-official', model: 'deepseek-flash' };

function llmWith({ providers = [{ id: ROUTE.provider, name: 'DeepSeek' }], chunks }) {
  const llm = {
    providers,
    calls: [],
    listProviders: () => llm.providers,
    async *stream(options) {
      llm.calls.push(options);
      yield* chunks;
    },
  };
  return llm;
}

const answered = [
  { type: 'text-delta', index: 0, text: '{"summary":' },
  { type: 'text-delta', index: 0, text: '"x"}' },
  { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
  { type: 'finish', reason: { kind: 'stop' } },
];

test('a distillation is one request on the session\'s route, as an instructions message of this plugin', async () => {
  const llm = llmWith({ chunks: answered });
  assert.deepEqual(await dshModel(() => llm).complete(ROUTE, 'Below is the record…', undefined), { answer: '{"summary":"x"}', usage: { inputTokens: 10, outputTokens: 4 } });
  const [call] = llm.calls;
  assert.deepEqual([call.provider, call.model], [ROUTE.provider, ROUTE.model]);
  assert.deepEqual(call.messages.map((message) => [message.role, message.source, message.content]), [['user', { kind: 'plugin:evolver', form: 'instructions' }, [{ type: 'text', text: 'Below is the record…' }]]]);
});

test('a route dsh registers after the session started is waited for', async () => {
  const llm = llmWith({ providers: [], chunks: answered });
  setTimeout(() => { llm.providers = [{ id: ROUTE.provider }]; }, 250);
  const running = setInterval(() => {}, 50);
  try {
    const { answer } = await dshModel(() => llm).complete(ROUTE, 'prompt', undefined);
    assert.equal(answer, '{"summary":"x"}');
  } finally {
    clearInterval(running);
  }
});

test('a failed model call, a missing route or a missing model service fails the try', async () => {
  const failing = llmWith({ chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'quota exceeded', code: 'QUOTA_EXCEEDED' } } }] });
  await assert.rejects(dshModel(() => failing).complete(ROUTE, 'prompt'), /quota exceeded/);
  const routeless = llmWith({ providers: [], chunks: answered });
  await assert.rejects(dshModel(() => routeless).complete(ROUTE, 'prompt', AbortSignal.abort()), /no provider route "deepseek-official"/);
  assert.deepEqual(routeless.calls, []);
  await assert.rejects(dshModel(() => null).complete(ROUTE, 'prompt'), /no model service/);
});

import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { headlessKimi } from '../../../hosts/kimi/model.js';

const config = () => ({
  default_model: 'route-a',
  providers: {
    'account-a': { type: 'openai', base_url: 'https://api-a.example/v1', api_key_env: 'ACCOUNT_A' },
    'account-b': { type: 'openai', base_url: 'https://api-b.example/v1', api_key_env: 'ACCOUNT_B' },
  },
  models: {
    'route-a': { provider: 'account-a', model: 'same-model', max_context_size: 32768, capabilities: ['tool_use'] },
    'route-b': { provider: 'account-b', model: 'same-model', max_context_size: 32768, capabilities: ['tool_use', 'thinking'], support_efforts: ['low', 'high'], default_effort: 'low' },
  },
});

const managed = () => ({
  providers: {
    'managed:kimi-code': { type: 'kimi', base_url: 'https://api.kimi.com/coding/v1', api_key: '', oauth: { storage: 'file', key: 'oauth/kimi-code' } },
  },
  models: {
    'kimi-code/k3': { provider: 'managed:kimi-code', model: 'k3', max_context_size: 1048576, max_output_size: 256, display_name: 'K3', capabilities: ['thinking', 'always_thinking', 'tool_use'], support_efforts: ['low', 'high', 'max'], default_effort: 'max' },
  },
});

test('official managed Kimi chooses the exact CN access-only slot and keeps the native provider family', () => {
  const sourceHome = resolve('source-kimi-home'), home = resolve('private-completion-home');
  const selected = headlessKimi.config.select(managed(), { alias: 'kimi-code/k3', effort: 'low' }, { KIMI_CODE_HOME: sourceHome });
  assert.deepEqual(selected?.route, { alias: 'kimi-code/k3', providerId: 'managed:kimi-code', providerType: 'kimi', model: 'k3', protocol: 'openai', endpoint: 'https://api.kimi.com/coding/v1', effort: 'low' });
  assert.deepEqual(selected.credential, { kind: 'oauth-access', tokenFile: join(sourceHome, 'credentials', 'kimi-code.json'), deviceIdFile: join(sourceHome, 'device_id') });
  const deviceId = '00000000-0000-4000-8000-000000000000';
  const prepared = headlessKimi.prepare({ ...selected, deviceId }, { home, credentialEnv: 'EVOLVER_MODEL_API_KEY' });
  const cfg = prepared.files['kimi-home/config.toml'].value;
  assert.deepEqual(cfg.providers, { 'managed:kimi-code': { type: 'kimi', base_url: 'https://api.kimi.com/coding/v1', api_key_env: 'EVOLVER_MODEL_API_KEY' } });
  assert.deepEqual(prepared.files['kimi-home/device_id'], { format: 'text', value: deviceId });
  assert.equal(cfg.models['kimi-code/k3'].default_effort, 'low');
  assert.equal(cfg.models['kimi-code/k3'].max_output_size, 256);
  assert.equal(JSON.stringify(prepared).includes('credentials'), false);
});

test('managed Kimi rejects other endpoints, credential slots, auth overrides and mixed credentials', () => {
  const hint = { alias: 'kimi-code/k3', effort: 'high' };
  for (const [change, env] of [
    [p => { p.base_url = 'https://api.kimi.ai/coding/v1'; }, {}],
    [p => { p.oauth.key = 'oauth/../../elsewhere'; }, {}],
    [p => { p.oauth.storage = 'keyring'; }, {}],
    [p => { p.oauth.oauth_host = 'https://auth.kimi.ai'; }, {}],
    [p => { p.api_key_env = 'OTHER_ACCOUNT'; }, { OTHER_ACCOUNT: 'fixture-other-account' }],
    [p => { p.api_key = 123; }, {}],
    [() => {}, { KIMI_CODE_BASE_URL: 'https://api.kimi.ai/coding/v1' }],
    [() => {}, { KIMI_OAUTH_HOST: 'https://auth.kimi.ai' }],
  ]) {
    const cfg = managed();
    change(cfg.providers['managed:kimi-code']);
    assert.equal(headlessKimi.config.select(cfg, hint, env), null);
  }
});

test('a Kimi API-key provider preserves its family and explicit native wire protocol', () => {
  const cfg = managed();
  cfg.providers['managed:kimi-code'] = { type: 'kimi', base_url: 'https://api.moonshot.ai/v1', api_key_env: 'FIXTURE_KEY' };
  cfg.models['kimi-code/k3'].protocol = 'openai_responses';
  const selected = headlessKimi.config.select(cfg, { alias: 'kimi-code/k3', effort: 'high' }, { FIXTURE_KEY: 'fixture-not-a-real-key' });
  assert.equal(selected.route.protocol, 'openai_responses');
  assert.equal(selected.route.providerType, 'kimi');
  assert.deepEqual(selected.credential, { kind: 'api-key', env: 'FIXTURE_KEY' });
  const cfgPrivate = headlessKimi.prepare(selected, { home: 'scratch', credentialEnv: 'PRIVATE_KEY_ENV' }).files['kimi-home/config.toml'].value;
  assert.equal(cfgPrivate.providers['managed:kimi-code'].type, 'kimi');
  assert.equal(cfgPrivate.models['kimi-code/k3'].protocol, 'openai_responses');
});

test('exact native alias selects its provider account, upstream model and active thinking effort', () => {
  const selected = headlessKimi.config.select(config(), { alias: 'route-b', effort: 'high' }, { ACCOUNT_A: 'fixture-a', ACCOUNT_B: 'fixture-b' });
  assert.deepEqual(selected.route, { alias: 'route-b', providerId: 'account-b', model: 'same-model', protocol: 'openai', endpoint: 'https://api-b.example/v1', effort: 'high' });
  assert.deepEqual(selected.credential, { kind: 'api-key', env: 'ACCOUNT_B' });
  assert.equal(headlessKimi.config.select(config(), null, { ACCOUNT_A: 'fixture-a' }), null);
  assert.equal(headlessKimi.config.select(config(), { alias: 'missing' }, { ACCOUNT_A: 'fixture-a' }), null);
});

test('private completion files contain only the selected route and an environment credential reference', () => {
  const selected = headlessKimi.config.select(config(), { alias: 'route-b', effort: 'high' }, { ACCOUNT_B: 'fixture-b' });
  const prepared = headlessKimi.prepare(selected, { home: join('scratch', 'home'), credentialEnv: 'EVOLVER_MODEL_API_KEY' });
  const cfg = prepared.files['kimi-home/config.toml'].value;
  assert.deepEqual(Object.keys(cfg.providers), ['account-b']);
  assert.deepEqual(Object.keys(cfg.models), ['route-b']);
  assert.equal(cfg.providers['account-b'].api_key_env, 'EVOLVER_MODEL_API_KEY');
  assert.equal(JSON.stringify(prepared).includes('fixture-b'), false);
  assert.equal(cfg.default_model, 'route-b');
  assert.equal(cfg.models['route-b'].default_effort, 'high');
  assert.equal(cfg.telemetry, false);
  assert.equal(cfg.builtin_product_skills, false);
  assert.match(prepared.files['kimi-home/agents/agent.md'].value, /override: true\ntools: \[\]\nsubagents: \[\]/);
  assert.equal(prepared.env.KIMI_CODE_HOME, join('scratch', 'home', 'kimi-home'));
});

test('thinking off does not inherit a model default and requires explicit native session selection', () => {
  const cfg = config(); cfg.models['route-b'].default_effort = 'high';
  const selected = headlessKimi.config.select(cfg, { alias: 'route-b', effort: 'off' }, { ACCOUNT_B: 'fixture-b' });
  const prepared = headlessKimi.prepare(selected, { home: 'scratch', credentialEnv: 'EVOLVER_MODEL_API_KEY' });
  assert.equal(prepared.files['kimi-home/config.toml'].value.models['route-b'].default_effort, undefined);
  assert.deepEqual(headlessKimi.sessionConfig(selected.route, selected), [{ id: 'thinking', value: 'off' }]);
  const simple = headlessKimi.config.select(cfg, { alias: 'route-a', effort: 'off' }, { ACCOUNT_A: 'fixture-a' });
  assert.deepEqual(headlessKimi.sessionConfig(simple.route, simple), []);
  assert.equal(headlessKimi.config.select(cfg, { alias: 'route-a', effort: 'high' }, { ACCOUNT_A: 'fixture-a' }), null);
});

test('adaptive Responses model preserves the observed thinking toggle without declared levels', () => {
  const cfg = config();
  cfg.providers['account-b'].type = 'openai_responses';
  const model = cfg.models['route-b'];
  delete model.support_efforts;
  delete model.default_effort;
  model.adaptive_thinking = true;
  const env = { ACCOUNT_A: 'fixture-a', ACCOUNT_B: 'fixture-b' };
  for (const effort of ['on', 'off']) {
    const selected = headlessKimi.config.select(cfg, { alias: 'route-b', effort }, env);
    assert.equal(selected?.route.protocol, 'openai_responses');
    assert.equal(selected.route.effort, effort);
    assert.deepEqual(selected.credential, { kind: 'api-key', env: 'ACCOUNT_B' });
    const prepared = headlessKimi.prepare(selected, { home: 'scratch', credentialEnv: 'EVOLVER_MODEL_API_KEY' });
    assert.equal(prepared.files['kimi-home/config.toml'].value.models['route-b'].adaptive_thinking, true);
    assert.deepEqual(headlessKimi.sessionConfig(selected.route, selected), [{ id: 'thinking', value: effort }]);
  }
  for (const effort of [undefined, 'high']) {
    assert.equal(headlessKimi.config.select(cfg, { alias: 'route-b', effort }, env), null);
  }
  model.adaptive_thinking = 'true';
  assert.equal(headlessKimi.config.select(cfg, { alias: 'route-b', effort: 'off' }, env), null);
});

test('unsafe or unresolved configuration cannot switch to another credential route', () => {
  const env = { ACCOUNT_B: 'fixture-b' }, hint = { alias: 'route-b', effort: 'high' };
  for (const provider of [
    { type: 'kimi', base_url: 'https://api.example/v1', oauth: 'account-b' },
    { type: 'openai', base_url: 'https://user:secret@api.example/v1', api_key_env: 'ACCOUNT_B' },
    { type: 'openai', base_url: 'https://api.example/v1?key=secret', api_key_env: 'ACCOUNT_B' },
    { type: 'openai', base_url: 'https://api.example/v1', api_key_env: 'ACCOUNT_B', headers: { Authorization: 'fixture' } },
    { type: 'openai', base_url: 'https://api.example/v1', api_key_env: 'ACCOUNT_B', api_key: 'other-fixture' },
  ]) {
    const cfg = config(); cfg.providers['account-b'] = provider;
    assert.equal(headlessKimi.config.select(cfg, hint, env), null);
  }
  assert.equal(headlessKimi.config.select(config(), hint, {}), null);
  assert.equal(headlessKimi.config.select(config(), { alias: 'route-b' }, env), null);
});

test('private completion requires native provider-finish, exact route and zero tool evidence', () => {
  const records = [
    { type: 'metadata', protocol_version: '1.5' },
    { type: 'turn.prompt', agentId: 'main', turnId: 0, promptId: 'p', origin: { kind: 'user' } },
    { type: 'llm.tools_snapshot', agentId: 'main', tools: [] },
    { type: 'llm.request', agentId: 'main', modelAlias: 'route-b', model: 'same-model', provider: 'openai', thinkingEffort: 'high', turnStep: '0.1' },
    { type: 'context.append_loop_event', agentId: 'main', event: { type: 'step.end', uuid: 'last', turnId: '0', finishReason: 'end_turn', providerFinishReason: 'completed', usage: { inputOther: 8, inputCacheRead: 2, inputCacheCreation: 1, output: 4 } } },
    { type: 'turn.ended', agentId: 'main', turnId: 0, reason: 'completed' },
  ];
  const facts = headlessKimi.facts.decode(records);
  assert.deepEqual(facts, { reason: 'completed', error: false, providerFinish: 'completed', model: 'same-model', alias: 'route-b', protocol: 'openai', thinkingEffort: 'high', toolSnapshots: [0], toolCalls: 0, usage: { inputTokens: 11, outputTokens: 4 } });
  const missingFinish = structuredClone(records); delete missingFinish[4].event.providerFinishReason;
  assert.equal(headlessKimi.facts.decode(missingFinish).providerFinish, null);
  const secondPrompt = [...records, { ...records[1], turnId: 1, promptId: 'another' }];
  assert.equal(headlessKimi.facts.decode(secondPrompt).error, true);
  assert.equal(headlessKimi.facts.decode(records.slice(1)).error, true);
});

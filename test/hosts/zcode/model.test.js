import assert from 'node:assert/strict';
import { test } from 'node:test';

import { headlessZCode } from '../../../hosts/zcode/model.js';

const selection = {
  providerId: 'fixture-responses',
  modelId: 'fixture-model',
  options: { reasoningLevel: 'high' },
};
const modelRule = {
  providerId: 'fixture-responses',
  modelId: 'fixture-model',
  config: {
    enabled: true,
    properties: { contextWindow: 500_000 },
    optionSpecs: { maxOutputTokens: { max: 500_000 } },
  },
};

function config() {
  return { schemaVersion: 1, config: {
    providerOrder: ['other-provider', 'fixture-responses'],
    providerConfigRules: { providerRules: [
      { providerId: 'other-provider', config: { access: { apiKey: 'other-fixture-key' } } },
      { providerId: 'fixture-responses', providerName: 'Fixture', config: {
        group: 'standard-personal',
        access: { type: 'api-key', apiKey: 'selected-fixture-key' },
        api: { type: 'openai-responses', baseUrl: 'https://fixture.example/v1' },
        personalModelIds: ['fixture-model', 'other-model'],
        modelOrder: ['other-model', 'fixture-model'],
      } },
    ] },
    modelConfigRules: {
      providerModelRules: [structuredClone(modelRule), { ...structuredClone(modelRule), modelId: 'other-model' }],
      manualProviderModelRules: [],
    },
  } };
}

const builtin = JSON.stringify({ schemaVersion: 1, config: {
  providerConfigRules: { providerRules: [{ providerId: 'builtin-provider' }] },
  modelConfigRules: { modelRules: [], modelApiRules: [] },
} });
const prepare = (source) => headlessZCode.configFile.prepare([JSON.stringify(source), builtin], { selection });

test('ZCode isolates a Desktop Responses route with only the selected provider and model rule', () => {
  const { content, files } = prepare(config());
  const isolated = JSON.parse(content).config;
  assert.deepEqual(isolated.defaultModelSelection, selection);
  assert.deepEqual(isolated.providerConfigRules.providerRules, [{
    providerId: 'fixture-responses', providerName: 'Fixture', config: {
      group: 'standard-personal',
      access: { type: 'api-key', apiKey: 'selected-fixture-key' },
      api: { type: 'openai-responses', baseUrl: 'https://fixture.example/v1' },
      personalModelIds: ['fixture-model'],
    },
  }]);
  assert.deepEqual(isolated.modelConfigRules.providerModelRules, [modelRule]);
  assert.deepEqual(JSON.parse(files['builtin-providers.json']).config.providerConfigRules.providerRules, []);
  assert.doesNotMatch(content, /other-provider|other-model|other-fixture-key/);
});

test('ZCode rejects model overrides that could change the selected Responses route', () => {
  const unsupported = { code: 'MODEL_UNAVAILABLE', reason: 'auth_unsupported' };
  const cases = [
    ['selected model route override', (source) => {
      source.modelConfigRules.providerModelRules[0].config.properties.api = { baseUrl: 'https://other.example/v1' };
    }],
    ['selected provider header override', (source) => {
      source.providerConfigRules.providerRules[1].config.api.headers = { Authorization: 'other-fixture-key' };
    }],
    ['duplicate selected model rule', (source) => {
      source.modelConfigRules.providerModelRules.push(modelRule);
    }],
    ['manual model rule', (source) => {
      source.modelConfigRules.manualProviderModelRules.push(modelRule);
    }],
  ];
  for (const [name, edit] of cases) {
    const document = config();
    edit(document.config);
    assert.throws(() => prepare(document), unsupported, name);
  }
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { headlessZCode } from '../../../hosts/zcode/model.js';
import profile from '../../../hosts/zcode/profile.js';
import { executableOf } from '../../../lib/runtime/process/which.js';

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

test('ZCode keeps the native session database when its provider data root changes', () => {
  const home = join(tmpdir(), 'evolver-zcode-native-home');
  const selected = join(tmpdir(), 'evolver-zcode-selected-home');
  const env = { HOME: home, USERPROFILE: home, ZCODE_DATA_BASE_DIR: ` ${selected} ` };
  assert.equal(profile.turnEnd.statusRecord.file(env), join(home, '.zcode', 'cli', 'db', 'db.sqlite'));
  assert.equal(profile.modelRecord.file(env), join(home, '.zcode', 'cli', 'db', 'db.sqlite'));
  assert.equal(headlessZCode.configFile.source(env)[0], join(selected, '.zcode', 'v2', 'provider_config.json'));
  assert.equal(profile.stateDir(env), join(selected, '.zcode', 'cli', 'evolver-plugin'));
});

test('ZCode rejects a relative provider source from a blank data root and preserves explicit file overrides', () => {
  const home = join(tmpdir(), 'evolver-zcode-native-home');
  for (const base of [undefined, '', '   ']) {
    const env = { HOME: home, USERPROFILE: home, ZCODE_DATA_BASE_DIR: base };
    assert.equal(profile.turnEnd.statusRecord.file(env), join(home, '.zcode', 'cli', 'db', 'db.sqlite'));
    assert.equal(headlessZCode.configFile.source(env)[0], base === undefined ? join(home, '.zcode', 'v2', 'provider_config.json') : null);
    const database = join(home, 'custom.sqlite');
    const provider = join(home, 'provider.json');
    const override = { ...env, ZCODE_SESSION_DB_PATH: ` ${database} `, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: ` ${provider} ` };
    assert.equal(profile.turnEnd.statusRecord.file(override), database);
    assert.equal(profile.modelRecord.file(override), database);
    assert.equal(headlessZCode.configFile.source(override)[0], provider);
    assert.equal(profile.turnEnd.statusRecord.file({ ...env, ZCODE_SESSION_DB: database }), database);
  }
});

test('ZCode isolates a personal Responses route with only the selected provider and model rule', () => {
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

test('standalone ZCode requires an explicit regular CLI bundle', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-zcode-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'zcode.cjs');
  const command = headlessZCode.command;
  const resolve = (env) => executableOf({ ...command, dirs: command.dirs(env) }, { env });
  assert.equal(resolve({ ZCODE_CLI_PATH: 'zcode.cjs' }), null);
  assert.equal(resolve({ ZCODE_CLI_PATH: file }), null);
  mkdirSync(file);
  assert.equal(resolve({ ZCODE_CLI_PATH: file }), null);
  rmdirSync(file);
  writeFileSync(file, '');
  assert.equal(resolve({ PATH: dir, LOCALAPPDATA: dir }), null);
  assert.deepEqual(resolve({ ZCODE_CLI_PATH: file }), { file, viaNode: true });
});

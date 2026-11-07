// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const nativeHomeOf = (env) => (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir();
export const homeOf = (env) => env.ZCODE_DATA_BASE_DIR?.trim() || nativeHomeOf(env);
export const databaseOf = (env) => {
  const file = env.ZCODE_SESSION_DB_PATH?.trim() || env.ZCODE_SESSION_DB?.trim() || join(nativeHomeOf(env), '.zcode', 'cli', 'db', 'db.sqlite');
  return isAbsolute(file) ? file : null;
};
const providerConfigOf = (env) => {
  const base = env.ZCODE_DATA_BASE_DIR?.trim() ?? nativeHomeOf(env);
  const source = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() || join(base, '.zcode', 'v2', 'provider_config.json');
  return isAbsolute(source) ? source : null;
};
const MAX_TOKENS = 1_024;
const REQUEST_ID = 'evolver-distill';
const BUILTIN_FILE = 'builtin-providers.json';
const id = (value) => typeof value === 'string' && /^[\w.@:/+-]{1,256}$/.test(value);
const only = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).every((key) => keys.includes(key));
const order = (value) => value === undefined || (Array.isArray(value) && value.every(id));
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

export const modelRecord = Object.freeze({
  file: databaseOf,
  query: `SELECT json_extract(m.data, '$.modelSelection') AS selection,
    MIN(u.provider_id) AS provider, MIN(u.model_id) AS model, MIN(u.variant) AS variant,
    COUNT(DISTINCT json_array(u.provider_id, u.model_id, u.variant)) AS routes
    FROM turn_usage t JOIN message m ON m.id = t.user_message_id AND m.session_id = t.session_id
    JOIN model_usage u ON u.session_id = t.session_id AND u.turn_id = t.turn_id
    WHERE t.session_id = ? AND t.turn_id = ? AND t.status = 'completed'
    AND u.query_source = 'main_turn' GROUP BY m.id HAVING SUM(u.status = 'completed') > 0`,
});

const json = (text) => { try { return JSON.parse(text); } catch { return null; } };

export function modelOf(row, started, closed) {
  if (!started || !closed) return { unavailable: 'credential_missing' };
  if (started !== closed) return { unavailable: 'route_changed' };
  const selection = json(row?.selection);
  if (row?.routes !== 1 || !only(selection, ['providerId', 'modelId', 'options'])
    || !id(row.provider) || !id(row.model) || selection.providerId !== row.provider || selection.modelId !== row.model
    || !only(selection.options, ['reasoningLevel']) || !id(row.variant) || selection.options.reasoningLevel !== row.variant) {
    return { unavailable: 'route_unresolved' };
  }
  return { selection, configDigest: started.split(':').at(-1) };
}

function unavailable(reason) {
  return Object.assign(new Error('The captured ZCode provider is unavailable'), { code: 'MODEL_UNAVAILABLE', reason });
}

function modelRulesFor(rules, selection) {
  if (rules === undefined) return undefined;
  if (!only(rules, ['providerModelRules', 'manualProviderModelRules'])) throw unavailable('auth_unsupported');
  const { providerModelRules = [], manualProviderModelRules = [] } = rules;
  if (!Array.isArray(providerModelRules) || !Array.isArray(manualProviderModelRules) || manualProviderModelRules.length
    || providerModelRules.some((rule) => !only(rule, ['providerId', 'modelId', 'config'])
      || !id(rule.providerId) || !id(rule.modelId))) throw unavailable('auth_unsupported');
  const selected = providerModelRules.filter((rule) => rule.providerId === selection.providerId && rule.modelId === selection.modelId);
  if (selected.length > 1) throw unavailable('auth_unsupported');
  for (const { config } of selected) {
    if (!only(config, ['enabled', 'properties', 'optionSpecs']) || config.enabled !== true
      || !only(config.properties, ['contextWindow']) || !positiveInteger(config.properties.contextWindow)
      || !only(config.optionSpecs, ['maxOutputTokens']) || !only(config.optionSpecs.maxOutputTokens, ['max'])
      || !positiveInteger(config.optionSpecs.maxOutputTokens.max)) throw unavailable('auth_unsupported');
  }
  return { providerModelRules: selected, manualProviderModelRules };
}

function configFor([text, builtinText], { selection }) {
  const document = json(text);
  const source = document?.config;
  const rules = source?.providerConfigRules?.providerRules;
  const matching = Array.isArray(rules) ? rules.filter((rule) => rule?.providerId === selection.providerId) : [];
  const [rule] = matching;
  const provider = rule?.config;
  const api = provider?.api;
  const key = provider?.access?.apiKey;
  // shortcut: admit the verified personal API-key schema; support OAuth once ZCode exposes a stable account binding.
  if (document?.schemaVersion !== 1 || !only(source, ['providerConfigRules', 'modelConfigRules', 'defaultModelSelection', 'providerOrder'])
    || !order(source.providerOrder)
    || !only(source.providerConfigRules, ['providerRules']) || matching.length !== 1 || !only(rule, ['providerId', 'providerName', 'config'])
    || !only(provider, ['group', 'access', 'api', 'personalModelIds', 'modelOrder']) || !order(provider.modelOrder)
    || provider.group !== 'standard-personal' || !only(provider.access, ['type', 'apiKey'])
    || provider.access.type !== 'api-key' || !only(api, ['type', 'baseUrl'])
    || !['openai-chat-completions', 'openai-responses'].includes(api.type)
    || !Array.isArray(provider.personalModelIds) || !provider.personalModelIds.includes(selection.modelId)) {
    throw unavailable('auth_unsupported');
  }
  const modelConfigRules = modelRulesFor(source.modelConfigRules, selection);
  if (typeof key !== 'string' || !key.trim() || /[\u0000-\u001f\u007f]/.test(key)) throw unavailable('credential_missing');
  let url;
  try { url = new URL(api.baseUrl); } catch { throw unavailable('route_unresolved'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) throw unavailable('route_unresolved');
  const builtin = json(builtinText);
  const builtInProviders = builtin?.config?.providerConfigRules?.providerRules;
  const modelRules = builtin?.config?.modelConfigRules;
  if (builtin?.schemaVersion !== 1 || !Array.isArray(builtInProviders) || !Array.isArray(modelRules?.modelRules)
    || !Array.isArray(modelRules.modelApiRules) || builtInProviders.some((rule) => rule?.providerId === selection.providerId)) {
    throw unavailable('unsafe_runtime');
  }
  return {
    content: JSON.stringify({ schemaVersion: 1, config: {
      providerConfigRules: { providerRules: [{ ...rule, config: {
        group: provider.group, access: provider.access, api, personalModelIds: [selection.modelId],
      } }] },
      modelConfigRules,
      defaultModelSelection: selection,
    } }),
    // Keep ZCode's model/endpoint-specific option mapping without exposing other providers.
    files: { [BUILTIN_FILE]: JSON.stringify({ schemaVersion: 1, revision: builtin.revision, config: {
      providerConfigRules: { templateRules: [], providerRules: [] },
      modelConfigRules: modelRules,
    } }) },
  };
}

const isolatedEnv = (env, { workdir, configPath }) => ({
  SystemRoot: env.SystemRoot, WINDIR: env.WINDIR,
  HOME: workdir, USERPROFILE: workdir, APPDATA: workdir, LOCALAPPDATA: workdir, TMP: workdir, TEMP: workdir, TMPDIR: workdir,
  XDG_CONFIG_HOME: workdir, XDG_DATA_HOME: workdir, XDG_CACHE_HOME: workdir, XDG_STATE_HOME: workdir,
  ZCODE_DATA_BASE_DIR: workdir, ZCODE_HOME: workdir,
  ZCODE_STORAGE_DIR: join(workdir, '.zcode'),
  ZCODE_MODEL_TELEMETRY_ENABLED: '0',
  ZCODE_AUTO_UPDATE_ENABLED: '0',
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: configPath,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(workdir, BUILTIN_FILE),
  ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: join(workdir, BUILTIN_FILE),
});

function completionOf({ stdout }, { selection }) {
  const replies = stdout.split('\n').map(json).filter((frame) => frame?.id === REQUEST_ID);
  const result = replies.length === 1 ? replies[0].result : null;
  if (!result || result.selection?.providerId !== selection.providerId || result.selection?.modelId !== selection.modelId
    || result.selection?.options?.reasoningLevel !== selection.options.reasoningLevel || result.finishReason !== 'stop'
    || (result.toolCalls !== undefined && (!Array.isArray(result.toolCalls) || result.toolCalls.length))
    || typeof result.text !== 'string' || !result.text.trim()) throw new Error('ZCode returned no complete answer on the captured route');
  const { inputTokens, outputTokens } = result.usage ?? {};
  return { answer: result.text, ...(Number.isSafeInteger(inputTokens) && inputTokens >= 0 && Number.isSafeInteger(outputTokens) && outputTokens >= 0
    && { usage: { inputTokens, outputTokens } }) };
}

export const headlessZCode = Object.freeze({
  kind: 'cli',
  // shortcut: use the version-tested Desktop-bundled CLI on Windows until standalone install layouts are verified.
  command: { names: ['zcode.cjs'], nodeScript: true, dirs: (env) => {
    const local = env.LOCALAPPDATA || join(homeOf(env), 'AppData', 'Local');
    return isAbsolute(local) ? [join(local, 'Programs', 'ZCode', 'resources', 'glm')] : [];
  } },
  // ZCode refreshes the live provider registry on a one-second poll.
  configFile: { source: (env) => {
    const builtin = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim();
    return [providerConfigOf(env), isAbsolute(builtin || '') ? builtin : null];
  }, prepare: configFor, bind: true, settleMs: 2_000 },
  workdirFiles: {
    // ZCode's development entry searches upward for the first .env.
    '.env': '',
    '.zcode/cli/config.json': JSON.stringify({ plugins: { enabled: false, dirs: [] }, hooks: { enabled: false }, mcp: { enabled: false, servers: {} } }),
  },
  isolated: true,
  env: isolatedEnv,
  timeoutMs: 90_000,
  args: () => ['app-server', '--stdio'],
  input: (prompt, { selection }, { workdir }) => JSON.stringify({
    id: REQUEST_ID, method: 'workspace/generateText', params: {
      workspace: { workspacePath: workdir, workspaceKey: workdir }, selection, prompt,
      querySource: REQUEST_ID, maxOutputTokens: MAX_TOKENS, operationId: REQUEST_ID, tools: [],
    },
  }) + '\n',
  closeInputOn: (line) => json(line)?.id === REQUEST_ID,
  parse: completionOf,
});

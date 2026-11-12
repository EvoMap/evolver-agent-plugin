// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from '../../lib/vendor/smol-toml/dist/index.js';

import { kimiHomeOf } from './paths.js';

const text = (value) => typeof value === 'string' && value.trim() ? value : null;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key) ? value[key] : null;
const only = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length <= 100);
const providerKeys = ['type', 'base_url', 'api_key', 'api_key_env', 'oauth'];
const modelKeys = [
  'provider', 'model', 'protocol', 'display_name', 'max_context_size', 'max_output_size', 'capabilities',
  'adaptive_thinking', 'support_efforts', 'default_effort',
];
const supportsThinking = (model) => model.adaptive_thinking === true
  || model.capabilities.includes('thinking')
  || model.capabilities.includes('always_thinking');
const protocols = ['openai', 'openai_responses', 'anthropic'];
const managedBase = 'https://api.kimi.com/coding/v1';
const managedAuth = 'https://auth.kimi.com';
const matches = (value, expected) => value === undefined || text(value)?.trim().replace(/\/+$/, '') === expected;

function managedAccess(provider, providerId, endpoint, env) {
  const ref = provider.oauth;
  if (provider.type !== 'kimi' || providerId !== 'managed:kimi-code' || endpoint !== managedBase
      || text(provider.api_key) || text(provider.api_key_env)
      || !object(ref) || !only(ref, ['storage', 'key', 'oauth_host'])
      || ref.storage !== 'file' || ref.key !== 'oauth/kimi-code' || !matches(ref.oauth_host, managedAuth)
      || !matches(env.KIMI_CODE_BASE_URL, managedBase)
      || !matches(env.KIMI_CODE_OAUTH_HOST, managedAuth)
      || !matches(env.KIMI_OAUTH_HOST, managedAuth)) return null;
  const home = kimiHomeOf(env);
  return {
    kind: 'oauth-access',
    tokenFile: join(home, 'credentials', 'kimi-code.json'),
    deviceIdFile: join(home, 'device_id'),
  };
}

function endpointOf(provider) {
  try {
    const url = new URL(provider.base_url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return null;
    }
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function credentialOf(provider, providerId, endpoint, env) {
  if (provider.oauth !== undefined) return managedAccess(provider, providerId, endpoint, env);
  const key = text(provider.api_key);
  const keyEnv = text(provider.api_key_env);
  if (Boolean(key) === Boolean(keyEnv) || (keyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv))) return null;
  const value = key ?? text(env[keyEnv]);
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return null;
  return { kind: 'api-key', ...(keyEnv ? { env: keyEnv } : { value }) };
}

/** Every credential the configuration names, so a captured route's stamp changes with any account it could reach. */
export function credentialsOf(config, env = {}) {
  if (!object(config?.providers)) return [];
  return Object.entries(config.providers).flatMap(([providerId, provider]) => {
    const endpoint = object(provider) ? endpointOf(provider) : null;
    const credential = endpoint && credentialOf(provider, providerId, endpoint, env);
    return credential ? [credential] : [];
  });
}

/** Keep the selected account and transport; never fall back to another credential or endpoint. */
export function selectRoute(config, hint, env = {}) {
  const alias = text(hint?.alias);
  const model = own(config?.models, alias);
  const providerId = text(model?.provider);
  const provider = own(config?.providers, providerId);
  if (!alias || !object(model) || !object(provider) || !only(model, modelKeys) || !only(provider, providerKeys)) {
    return null;
  }
  if ([provider.api_key, provider.api_key_env].some((value) => value !== undefined && typeof value !== 'string')) {
    return null;
  }
  const protocol = model.protocol ?? (provider.type === 'kimi' ? 'openai' : provider.type);
  if (!text(model.model) || !protocols.includes(protocol) || (provider.type !== 'kimi' && protocol !== provider.type)) {
    return null;
  }
  if (!Number.isSafeInteger(model.max_context_size) || model.max_context_size < 1 || !strings(model.capabilities)) {
    return null;
  }
  if (model.max_output_size !== undefined
      && (!Number.isSafeInteger(model.max_output_size) || model.max_output_size < 1)) return null;
  if (model.adaptive_thinking !== undefined && typeof model.adaptive_thinking !== 'boolean') return null;
  if (model.support_efforts !== undefined && !strings(model.support_efforts)) return null;
  const endpoint = endpointOf(provider);
  const credential = endpoint && credentialOf(provider, providerId, endpoint, env);
  if (!credential) return null;
  const thinking = supportsThinking(model);
  const effort = text(hint?.effort) ?? (thinking ? null : 'off');
  // Native models without named levels expose the binary thinking toggle.
  const enabledEfforts = model.support_efforts?.length ? model.support_efforts : ['on'];
  if (effort !== 'off' && (!thinking || !enabledEfforts.includes(effort))) return null;
  const route = {
    alias, providerId, model: model.model, protocol, endpoint, effort,
    ...(provider.type === 'kimi' && { providerType: 'kimi' }),
  };
  const { display_name, ...privateModel } = model;
  return { route, credential, model: privateModel };
}

export function prepareRoute(selected, { home, credentialEnv }) {
  const { route, model } = selected;
  const privateModel = { ...model };
  delete privateModel.default_effort;
  if (route.effort !== 'off') privateModel.default_effort = route.effort;
  const config = {
    default_model: route.alias, telemetry: false, auto_session_title: false,
    builtin_product_skills: false, merge_all_available_skills: false,
    providers: {
      [route.providerId]: { type: route.providerType ?? route.protocol, base_url: route.endpoint, api_key_env: credentialEnv },
    },
    models: { [route.alias]: privateModel },
    loop_control: { max_steps_per_turn: 1, max_attempts_per_step: 1, reserved_context_size: 1024 },
    task: { keep_alive_on_exit: false },
  };
  return {
    files: {
      'kimi-home/config.toml': { format: 'config', value: config },
      'kimi-home/agents/agent.md': {
        format: 'text',
        value: '---\nname: agent\ndescription: Isolated Evolver distiller\noverride: true\ntools: []\nsubagents: []\n---\nYou are a text-only distiller. Return only the requested structured response.\n',

      },
      ...(selected.deviceId && { 'kimi-home/device_id': { format: 'text', value: selected.deviceId } }),
    },
    env: {
      KIMI_CODE_HOME: join(home, 'kimi-home'),
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_DISABLE_TELEMETRY: '1',
      KIMI_DISABLE_CRON: '1',
    },
  };
}

/**
 * The route a turn ran on, from its session log's model requests (`row.model`), when the configuration stamp it began
 * with (`started`) is the one it ended with (`closed`).
 */
export function modelOf(row, started, closed) {
  if (!started || !closed) return { unavailable: 'credential_missing' };
  if (started !== closed) return { unavailable: 'route_changed' };
  const { alias, model, protocol, effort } = row?.model ?? {};
  if (![alias, model, protocol].every(text)) return { unavailable: 'route_unresolved' };
  return { selection: { alias, model, protocol, effort: text(effort) }, configDigest: started };
}

/** ACP's end_turn alone is insufficient: cross-check the owned private session's native evidence. */
export function completionFacts(records = []) {
  const main = records.filter((record) => record.agentId === 'main');
  const prompts = new Set(
    main.filter((record) => record.type === 'turn.prompt').map((record) => `${record.turnId}:${record.promptId}`),
  );
  const ended = main.filter((record) => record.type === 'turn.ended');
  const terminal = ended.at(-1);
  const requests = main.filter((record) => record.type === 'llm.request');
  const request = requests.at(-1);
  const routes = new Set(
    requests.map((record) => JSON.stringify([record.modelAlias, record.model, record.provider, record.thinkingEffort])),
  );
  const steps = main.filter((record) => record.type === 'context.append_loop_event'
    && record.event?.type === 'step.end'
    && String(record.event.turnId) === String(terminal?.turnId));
  const step = steps.at(-1)?.event;
  const snapshots = records.filter((record) => record.type === 'llm.tools_snapshot');
  const usage = step?.usage;
  const validUsage = usage && ['inputOther', 'inputCacheRead', 'inputCacheCreation', 'output']
    .every((key) => Number.isFinite(usage[key]) && usage[key] >= 0);
  const error = records.find((record) => record.type === 'metadata')?.protocol_version !== '1.5'
    || prompts.size !== 1 || routes.size !== 1 || !terminal || Boolean(terminal.error)
    || main.some((record) => record.type === 'turn.prompt'
      && (String(record.turnId) !== String(terminal.turnId) || record.origin?.kind !== 'user'))
    || snapshots.some((record) => record.agentId !== 'main' || !Array.isArray(record.tools))
    || records.some((record) => record.type === 'llm.request' && record.agentId !== 'main');
  return {
    reason: terminal?.reason ?? null, error,
    providerFinish: step?.finishReason === 'end_turn' ? step.providerFinishReason ?? null : null,
    model: request?.model ?? null, alias: request?.modelAlias ?? null, protocol: request?.provider ?? null,
    thinkingEffort: request?.thinkingEffort ?? null,
    toolSnapshots: snapshots.map((record) => Array.isArray(record.tools) ? record.tools.length : -1),
    toolCalls: records
      .filter((record) => record.type === 'context.append_loop_event' && record.event?.type === 'tool.call').length,
    ...(validUsage && {
      usage: {
        inputTokens: usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation,
        outputTokens: usage.output,
      },
    }),
  };
}

export const headlessKimi = Object.freeze({
  kind: 'acp',
  command: {
    names: ['kimi', 'kimi.exe'],
    dirs: (env) => [join(kimiHomeOf(env), 'bin'), join(env.HOME || env.USERPROFILE || homedir(), '.local', 'bin')],
  },
  args: () => ['acp'],
  config: {
    source: (env) => join(kimiHomeOf(env), 'config.toml'),
    parseConfig: parse,
    serializeConfig: stringify,
    select: selectRoute,
    credentials: credentialsOf,
  },
  prepare: prepareRoute,
  sessionConfig: (snapshot, selected) => supportsThinking(selected.model)
    ? [{ id: 'thinking', value: snapshot.effort }]
    : [],

  facts: { root: (home) => join(home, 'kimi-home'), logName: 'wire.jsonl', decode: completionFacts },
});

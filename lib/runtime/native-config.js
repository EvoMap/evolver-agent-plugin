// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const CONFIG_MAX_BYTES = 1024 * 1024;
const CREDENTIAL_MAX_BYTES = 16 * 1024;
const MIN_ACCESS_LIFETIME_SECONDS = 120;
const REASONS = new Set([
  'route_unresolved', 'route_changed', 'credential_missing', 'auth_unsupported', 'unsafe_runtime',
]);

/** A preflight failure, before a model request: callers retain the candidate without spending a model attempt. */
export class ModelUnavailable extends Error {
  constructor(reason) {
    const safe = REASONS.has(reason) ? reason : 'unsafe_runtime';
    super(`Model completion is unavailable (${safe})`);
    this.code = 'MODEL_UNAVAILABLE';
    this.reason = safe;
  }
}

function boundedBytes(file, maximum, reason) {
  if (typeof file !== 'string' || !isAbsolute(file)) throw new ModelUnavailable(reason);
  let fd;
  try {
    const leaf = lstatSync(file);
    if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.size > maximum) throw new Error();
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum || stat.dev !== leaf.dev || stat.ino !== leaf.ino) throw new Error();
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    for (;;) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (!read) break;
      length += read;
      if (length > maximum) throw new Error();
    }
    return bytes.subarray(0, length);
  } catch {
    throw new ModelUnavailable(reason);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function routeOf(value) {
  if (!value || typeof value !== 'object') throw new ModelUnavailable('route_unresolved');
  const route = {};
  for (const key of ['alias', 'providerId', 'model', 'protocol', 'endpoint']) {
    const item = value[key];
    if (typeof item !== 'string' || !item || item.length > 2048 || /[\0\r\n]/.test(item)) {
      throw new ModelUnavailable('route_unresolved');
    }
    route[key] = item;
  }
  if (!['openai', 'anthropic', 'openai_responses'].includes(route.protocol)) {
    throw new ModelUnavailable('route_unresolved');
  }
  if (value.providerType !== undefined) {
    if (typeof value.providerType !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(value.providerType)) {
      throw new ModelUnavailable('route_unresolved');
    }
    route.providerType = value.providerType;
  }
  let endpoint;
  try {
    endpoint = new URL(route.endpoint);
  } catch {
    throw new ModelUnavailable('route_unresolved');
  }
  if ((endpoint.protocol !== 'https:'
        && !(endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)))
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ModelUnavailable('route_unresolved');
  }
  route.endpoint = endpoint.href;
  if (value.effort !== undefined && value.effort !== null) {
    if (typeof value.effort !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.effort)) {
      throw new ModelUnavailable('route_unresolved');
    }
    route.effort = value.effort;
  }
  return route;
}

function credentialOf(credential, env) {
  if (credential?.kind === 'oauth-access') {
    try {
      const { access_token: secret, token_type: type, expires_at: expires } = JSON.parse(
        boundedBytes(credential.tokenFile, CREDENTIAL_MAX_BYTES, 'credential_missing').toString('utf8'),
      );
      const deviceId = boundedBytes(credential.deviceIdFile, 256, 'credential_missing').toString('utf8').trim();
      if (typeof secret !== 'string' || !/^[!-~]{1,8192}$/.test(secret)
          || typeof type !== 'string' || type.toLowerCase() !== 'bearer'
          || !Number.isSafeInteger(expires) || expires - Date.now() / 1000 < MIN_ACCESS_LIFETIME_SECONDS
          || !/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) throw new Error();
      return { secret, deviceId };
    } catch {
      throw new ModelUnavailable('credential_missing');
    }
  }
  if (credential?.kind !== 'api-key') throw new ModelUnavailable('auth_unsupported');
  if ((credential.value !== undefined) === (credential.env !== undefined)) {
    throw new ModelUnavailable('credential_missing');
  }
  if (credential.env !== undefined
      && (typeof credential.env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(credential.env))) {
    throw new ModelUnavailable('credential_missing');
  }
  const value = credential.env === undefined ? credential.value : env[credential.env];
  const secret = typeof value === 'string' ? value.trim() : '';
  if (!secret || /[\0\r\n]/.test(secret)) throw new ModelUnavailable('credential_missing');
  return { secret };
}

/** Read one bounded snapshot; raw config and credential remain local to this invocation. */
export function selectedConfig(declaration, hint, env) {
  let bytes;
  let selected;
  let source;
  try {
    source = declaration.config.source(env);
    bytes = boundedBytes(source, CONFIG_MAX_BYTES, 'route_unresolved');
    selected = declaration.config.select(declaration.config.parseConfig(bytes.toString('utf8')), hint, env);
  } catch (error) {
    if (error?.code === 'MODEL_UNAVAILABLE') throw new ModelUnavailable(error.reason);
    throw new ModelUnavailable('route_unresolved');
  }
  if (selected?.unavailable) throw new ModelUnavailable(selected.unavailable);
  const route = routeOf(selected?.route);
  const { secret, deviceId } = credentialOf(selected?.credential, env);
  const configRevision = createHash('sha256').update(bytes).digest('hex');
  const hash = createHash('sha256')
    .update(configRevision).update('\0').update(JSON.stringify(route)).update('\0').update(secret);
  if (deviceId) hash.update('\0').update(deviceId);
  const binding = hash.digest('hex');
  const origin = createHash('sha256').update(resolve(source)).digest('hex');
  return {
    selected: deviceId ? { ...selected, deviceId } : selected,
    route,
    secret,
    origin,
    snapshot: { ...route, configRevision, binding },
  };

}

export function sameSnapshot(actual, expected) {
  return expected && typeof expected === 'object' && JSON.stringify(actual) === JSON.stringify(expected);
}

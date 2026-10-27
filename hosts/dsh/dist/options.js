// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const isPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65_535;
const isBoolean = (value) => typeof value === 'boolean';

const CHECKS = Object.freeze({ proxyPort: isPort, assetPrimeEnabled: isBoolean, skillEnabled: isBoolean });

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function issuesOf(config) {
  return Object.entries(CHECKS)
    .filter(([key, isValid]) => config[key] !== undefined && !isValid(config[key]))
    .map(([key]) => ({ message: `Invalid Evolver option ${key}: ${JSON.stringify(config[key])}`, path: [key] }));
}

function validate(value) {
  const config = value ?? {};
  if (!isRecord(config)) return { issues: [{ message: 'Evolver options must be an object' }] };
  const issues = issuesOf(config);
  return issues.length > 0 ? { issues } : { value: config };
}

// Cordis validates a plugin's config through any Standard Schema, and the packed plugin ships no schema library.
// Options the standalone @evomap/dsh-evolver read and this plugin no longer does are let through, so a profile that
// still sets them keeps loading.
export const Config = Object.freeze({ '~standard': Object.freeze({ version: 1, vendor: 'evolver-plugin', validate }) });

export function pluginEnv(config, env) {
  return {
    ...env,
    ...(config?.proxyPort !== undefined && { EVOMAP_PROXY_PORT: String(config.proxyPort) }),
    ...(config?.assetPrimeEnabled === false && { EVOLVER_RECALL: 'off' }),
  };
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { readFileSync } from 'node:fs';

import { readState, writeState } from './store/file-lock.js';

export const PLUGIN_NAME = '@evomap/evolver-agent-plugin';

const FIELD = /^[A-Za-z0-9@/._+:-]{1,64}$/;
const fieldOf = (value) => (typeof value === 'string' && FIELD.test(value.trim()) ? value.trim() : null);

// A release stamps its version into the package.json at the root of every packed folder, which sits two levels
// above this file there as in a checkout.
function packageVersionOf(manifestUrl) {
  try {
    return fieldOf(JSON.parse(readFileSync(manifestUrl, 'utf8')).version);
  } catch {
    return null;
  }
}

/**
 * Who calls Evolver: this plugin, its version, the host agent and the version that host last reported, which one
 * event names and a later one (or a background worker) reuses. Evolver forwards it to the Hub for attribution.
 */
export function clientOf({ agent, releaseFile, manifestUrl = new URL('../../package.json', import.meta.url) }) {
  const pluginVersion = packageVersionOf(manifestUrl);
  let agentVersion;
  const knownAgentVersion = () => {
    if (agentVersion === undefined) {
      try {
        agentVersion = fieldOf(readState(releaseFile, {}).version);
      } catch {
        agentVersion = null;
      }
    }
    return agentVersion;
  };
  const fields = () => ({ agent, agentVersion: knownAgentVersion(), plugin: PLUGIN_NAME, pluginVersion });
  return {
    rememberAgentVersion(reported) {
      const version = fieldOf(reported);
      if (!version || version === knownAgentVersion()) return;
      agentVersion = version;
      try {
        writeState(releaseFile, { version });
      } catch {
        // The version still goes out from this process; only later ones miss it.
      }
    },
    headers() {
      const { agentVersion: release, pluginVersion: version } = fields();
      return {
        'X-Evomap-Client-Agent': agent,
        ...(release && { 'X-Evomap-Client-Agent-Version': release }),
        'X-Evomap-Client-Plugin': PLUGIN_NAME,
        ...(version && { 'X-Evomap-Client-Plugin-Version': version }),
      };
    },
    env() {
      const { agentVersion: release, pluginVersion: version } = fields();
      return {
        EVOLVER_CLIENT_AGENT: agent,
        ...(release && { EVOLVER_CLIENT_AGENT_VERSION: release }),
        EVOLVER_CLIENT_PLUGIN: PLUGIN_NAME,
        ...(version && { EVOLVER_CLIENT_PLUGIN_VERSION: version }),
      };
    },
  };
}

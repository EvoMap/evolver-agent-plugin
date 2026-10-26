// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const isPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65_535;

/**
 * The environment the plugin runs in, from its options in `opencode.json` / `tui.json`
 * (`["@evomap/evolver-opencode", { "proxyPort": 19820 }]`): `proxyPort` is the Proxy port used when
 * `~/.evolver/settings.json` names no URL. A wrong option fails the plugin's load.
 */
export function pluginEnv(options, env) {
  const port = options?.proxyPort;
  if (port === undefined) return env;
  if (!isPort(port)) throw new Error(`Invalid Evolver option proxyPort: ${JSON.stringify(port)}`);
  return { ...env, EVOMAP_PROXY_PORT: String(port) };
}

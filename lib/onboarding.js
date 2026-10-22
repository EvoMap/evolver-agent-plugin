// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// 2.0.39 is the first Proxy whose `/asset/fetch` recalls by text; an older one
// answers every recall empty, so priming silently never injects anything.
export const MIN_EVOLVER_VERSION = '2.0.39';

const STATE_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

export function versionOf(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return match ? match.slice(1, 4).join('.') : null;
}

export function isOlderThan(version, minimum) {
  const have = versionOf(version)?.split('.').map(Number);
  const need = versionOf(minimum)?.split('.').map(Number);
  if (!have || !need) return false;
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== need[index]) return have[index] < need[index];
  }
  return false;
}

export function upgradeNoticeText(version) {
  if (!version || !isOlderThan(version, MIN_EVOLVER_VERSION)) return null;
  return `Evolver ${version} is installed; network strategy recall needs ${MIN_EVOLVER_VERSION}+. `
    + 'Run `npm install -g @evomap/evolver@latest`, then `evolver` once to restart the Proxy.';
}

export function pendingClaimUrl(text) {
  try {
    const parsed = new URL(String(text ?? '').trim());
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:') return null;
    if (host !== 'evomap.ai' && !host.endsWith('.evomap.ai')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

// Shared by every throttled notice, so callers pass a namespaced key. A claim
// url carries a secret, so callers hash it before it becomes a key.
export function noticeDecision(state, key, ttlMs, now) {
  const previous = state?.[key];
  if (typeof previous === 'number' && now - previous < ttlMs) return { isDue: false, state };
  const next = { [key]: now };
  for (const [existing, timestamp] of Object.entries(state ?? {})) {
    if (existing !== key && typeof timestamp === 'number' && now - timestamp <= STATE_PRUNE_MS) next[existing] = timestamp;
  }
  return { isDue: true, state: next };
}

// On Windows the global `evolver` is an `evolver.cmd` shim, which Node will not
// start without a shell, so the probe goes through cmd.exe there.
export function versionProbeArgv(isWindows) {
  return isWindows ? ['cmd.exe', '/d', '/s', '/c', 'evolver --version'] : ['evolver', '--version'];
}

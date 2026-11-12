// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

function isLoopbackHost(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === '127.0.0.1' || value === '[::1]' || value === '::1' || value.endsWith('.localhost');
}

export function normalizeLoopbackUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (!isLoopbackHost(parsed.hostname) || parsed.username || parsed.password) return null;
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

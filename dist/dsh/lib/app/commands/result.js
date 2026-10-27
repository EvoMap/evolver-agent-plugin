// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const OUTPUT_MAX_CHARS = 4_000;

export const success = (text, extra = {}) => ({ ok: true, text, ...extra });
export const failure = (text, extra = {}) => ({ ok: false, text, ...extra });

export function shown(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > OUTPUT_MAX_CHARS ? `${text.slice(0, OUTPUT_MAX_CHARS)}\n…` : text;
}

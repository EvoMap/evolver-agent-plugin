// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { containsSecret, isSecretFile } from '../redact.js';

export const DIFF_MAX_BYTES = 256 * 1024;
export const DIFF_OMITTED = Object.freeze({ UNAVAILABLE: 'unavailable', TOO_LARGE: 'too_large', NOT_UTF8: 'not_utf8', SECRET: 'secret' });

const pathsOf = (diff) => diff.split('\n')
  .filter((line) => line.startsWith('diff --git '))
  .flatMap((line) => line.slice('diff --git '.length).split(/\s+/))
  .map((token) => token.replace(/^"|"$/g, '').replace(/^[ab]\//, ''));

const touchesSecret = (diff) => containsSecret(diff) || pathsOf(diff).some(isSecretFile);

/**
 * What a project snapshot carries of its work tree's diff (null when git gave none): `{ diff }`, or `{ diff_omitted }`
 * with a DIFF_OMITTED reason. The Proxy replays the diff as it is, so one holding a secret cannot be redacted in place
 * and is left out whole, as is one it could not apply: text that is not UTF-8 decodes with U+FFFD.
 */
export function diffFieldsOf(diff) {
  if (diff === null) return { diff_omitted: DIFF_OMITTED.UNAVAILABLE };
  if (Buffer.byteLength(diff) > DIFF_MAX_BYTES) return { diff_omitted: DIFF_OMITTED.TOO_LARGE };
  if (diff.includes('�')) return { diff_omitted: DIFF_OMITTED.NOT_UTF8 };
  if (touchesSecret(diff)) return { diff_omitted: DIFF_OMITTED.SECRET };
  return { diff };
}

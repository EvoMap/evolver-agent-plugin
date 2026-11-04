// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { containsSecret, isSecretFile } from '../redact.js';

export const DIFF_MAX_BYTES = 256 * 1024;
export const DIFF_OMITTED = Object.freeze({
  UNAVAILABLE: 'unavailable', TOO_LARGE: 'too_large', NOT_UTF8: 'not_utf8', SUBMODULE: 'submodule', SECRET: 'secret',
});

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function utf8TextOf(bytes) {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

const pathsOf = (diff) => diff.split('\n')
  .filter((line) => line.startsWith('diff --git '))
  .flatMap((line) => line.slice('diff --git '.length).split(/\s+/))
  .map((token) => token.replace(/^"|"$/g, '').replace(/^[ab]\//, ''));

const touchesSecret = (diff) => containsSecret(diff) || pathsOf(diff).some(isSecretFile);

// The Proxy rebuilds the tree in a fresh worktree, which checks out no submodule, so a change inside one is lost.
const touchesSubmodule = (diff) => /^[-+]Subproject commit /m.test(diff);

/**
 * What a project snapshot carries of its work tree's diff, from the bytes git wrote (null when it gave none): `{ diff }`,
 * or `{ diff_omitted }` with a DIFF_OMITTED reason. The Proxy replays the diff as it is, so one holding a secret cannot
 * be redacted in place and is left out whole, as is one it could not replay.
 */
export function diffFieldsOf(bytes) {
  if (bytes === null) return { diff_omitted: DIFF_OMITTED.UNAVAILABLE };
  if (bytes.length > DIFF_MAX_BYTES) return { diff_omitted: DIFF_OMITTED.TOO_LARGE };
  const diff = utf8TextOf(bytes);
  if (diff === null) return { diff_omitted: DIFF_OMITTED.NOT_UTF8 };
  if (touchesSubmodule(diff)) return { diff_omitted: DIFF_OMITTED.SUBMODULE };
  if (touchesSecret(diff)) return { diff_omitted: DIFF_OMITTED.SECRET };
  return { diff };
}

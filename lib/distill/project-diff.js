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

const GIT_HEADER = 'diff --git ';
const RENAMED = /^(?:rename|copy) (?:from|to) (.+)$/;
const unquoted = (path) => path.replace(/^"(.*)"$/, '$1');

// Git quotes no space in a path, so `diff --git a/<path> b/<path>` is split at its middle; a header whose halves
// differ is a rename or copy, whose `rename from` and `rename to` lines name both paths whole.
function headerPathOf(line) {
  const sides = line.slice(GIT_HEADER.length);
  if (sides.length % 2 === 0) return [];
  const half = (sides.length - 1) / 2;
  const [source, target] = [sides.slice(0, half), sides.slice(half + 1)].map((side) => unquoted(side).slice(2));
  return source === target ? [source] : [];
}

const pathsOf = (diff) => diff.split('\n').flatMap((line) => {
  if (line.startsWith(GIT_HEADER)) return headerPathOf(line);
  const renamed = RENAMED.exec(line);
  return renamed ? [unquoted(renamed[1])] : [];
});

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

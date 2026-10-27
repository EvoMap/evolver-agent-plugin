// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// Static imports and re-exports, a bare `import 'x'`, and a dynamic import of a quoted or backticked literal.
const IMPORT = /^\s*(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*(['"`])([^'"`$]+)\3\s*\)/gm;
// A dynamic import of anything but a plain literal, which leads where only the running code knows.
const COMPUTED_IMPORT = /\bimport\(\s*(?!(['"`])[^'"`$]+\1\s*\))/;

/** The modules `source` imports, as `{ specifier, isDynamic }`. */
export const importsOf = (source) => [...source.matchAll(IMPORT)]
  .map((match) => ({ specifier: match[1] ?? match[2] ?? match[4], isDynamic: match[4] !== undefined }));

export const hasComputedImport = (source) => COMPUTED_IMPORT.test(source);

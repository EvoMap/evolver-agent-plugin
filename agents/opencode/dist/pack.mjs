#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Assembles the publishable @evomap/evolver-opencode folder: the two OpenCode entries, every file of this repo they
// load (the shared lib/ and agents/opencode/, nothing of the MCP channel), and a package.json whose exports point
// at the entries. OpenCode loads `exports["./server"]` and `exports["./tui"]` from the package's root.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DIST = 'agents/opencode/dist';
const ENTRIES = { './server': `${DIST}/server.mjs`, './tui': `${DIST}/tui.mjs` };
const STATIC_IMPORT = /^(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|^import\s*['"]([^'"]+)['"]/gm;

const specifiersOf = (file) => [...readFileSync(path.join(ROOT, file), 'utf8').matchAll(STATIC_IMPORT)].map((match) => match[1] ?? match[2]);

/** Every file the entries load, relative to the repo root. The package ships no dependencies, so importing one fails. */
export function filesOf(entries = Object.values(ENTRIES)) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) throw new Error(`${file} imports the package ${specifier}, which @evomap/evolver-opencode does not ship`);
      queue.push(path.posix.join(path.posix.dirname(file), specifier));
    }
  }
  return [...seen].sort();
}

function manifestOf() {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, DIST, 'package.json'), 'utf8'));
  const exports = Object.fromEntries(Object.entries(ENTRIES).map(([key, file]) => [key, `./${file}`]));
  return { ...manifest, exports: { ...exports, './package.json': './package.json' }, files: ['agents/', 'lib/', 'LICENSE', 'README.md'] };
}

/** Writes the package into `out`, replacing what was there, and returns its file list. */
export function pack(out) {
  rmSync(out, { recursive: true, force: true });
  const copied = [...filesOf(), `${DIST}/package.json`];
  for (const file of copied) {
    mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    cpSync(path.join(ROOT, file), path.join(out, file));
  }
  cpSync(path.join(ROOT, 'LICENSE'), path.join(out, 'LICENSE'));
  cpSync(path.join(ROOT, DIST, 'README.md'), path.join(out, 'README.md'));
  writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(manifestOf(), null, 2)}\n`);
  return [...copied, 'LICENSE', 'README.md', 'package.json'];
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] ?? 'evolver-opencode-package');
  pack(out);
  console.log(`Packed @evomap/evolver-opencode into ${out}. Check it with \`npm pack --dry-run ${out}\`, publish it with \`npm publish ${out}\`.`);
}

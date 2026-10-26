#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds the folder one host installs. A host that copies only its plugin folder (WorkBuddy), or loads every
// component folder at a plugin's root (WorkBuddy, Antigravity), or loads an npm package (OpenCode) cannot install
// this repo as it is: it would miss lib/ or load the Claude Code plugin's skill, commands and hooks. The folder holds
// the files the host's entries load, at their paths in this repo, and the host's manifests at its root, as
// hosts/<host>/dist/pack.json lists them:
//   { "entries": [repo files the host runs], "root": { "path in the folder": "repo file or folder" },
//     "patch": { "a JSON file in root": { fields to set } } }

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const STATIC_IMPORT = /^(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|^import\s*['"]([^'"]+)['"]/gm;
const MODULE_PACKAGE = { private: true, type: 'module' };

const specifiersOf = (file) => [...readFileSync(path.join(ROOT, file), 'utf8').matchAll(STATIC_IMPORT)].map((match) => match[1] ?? match[2]);

/** The host's readers beside its profile, which the registry imports by name rather than by a static import. */
function profileFilesOf(host) {
  const dir = path.join(ROOT, 'hosts', host);
  return readdirSync(dir).filter((name) => /\.m?js$/.test(name) && statSync(path.join(dir, name)).isFile()).map((name) => `hosts/${host}/${name}`);
}

/** Every repo file the entries load, followed through static relative imports; a package import is refused. */
export function closureOf(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = path.posix.normalize(queue.pop());
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) throw new Error(`${file} imports the package ${specifier}, which a packed host does not ship`);
      queue.push(path.posix.join(path.posix.dirname(file), specifier));
    }
  }
  return [...seen].sort();
}

export function packSpecOf(host) {
  return JSON.parse(readFileSync(path.join(ROOT, 'hosts', host, 'dist', 'pack.json'), 'utf8'));
}

function copied(from, to) {
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}

function patchJson(file, fields) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, `${JSON.stringify({ ...value, ...fields }, null, 2)}\n`);
}

/** Writes `host`'s folder into `out`, replacing what was there, and returns the repo files it took. */
export function pack(host, out) {
  const spec = packSpecOf(host);
  const files = closureOf([...spec.entries, ...profileFilesOf(host)]);
  rmSync(out, { recursive: true, force: true });
  for (const file of files) copied(path.join(ROOT, file), path.join(out, file));
  for (const [target, source] of Object.entries(spec.root ?? {})) copied(path.join(ROOT, source), path.join(out, target));
  if (!existsSync(path.join(out, 'package.json'))) writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(MODULE_PACKAGE, null, 2)}\n`);
  for (const [target, fields] of Object.entries(spec.patch ?? {})) patchJson(path.join(out, target), fields);
  return files;
}

/** The hosts that install a packed folder: those with a hosts/<host>/dist/pack.json. */
export function packedHosts() {
  return readdirSync(path.join(ROOT, 'hosts')).filter((host) => existsSync(path.join(ROOT, 'hosts', host, 'dist', 'pack.json'))).sort();
}

// `all` packs every such host into <output folder>/<host>, the layout the repo's marketplaces point at.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [host, out] = process.argv.slice(2);
  if (!host || !out) {
    console.error('Usage: node scripts/pack.mjs <host | all> <output folder>');
    process.exit(2);
  }
  const targets = host === 'all' ? packedHosts().map((name) => [name, path.resolve(out, name)]) : [[host, path.resolve(out)]];
  for (const [name, folder] of targets) {
    pack(name, folder);
    console.log(`Packed ${name} into ${folder}.`);
  }
}

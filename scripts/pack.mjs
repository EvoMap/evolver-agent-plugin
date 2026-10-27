#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importsOf } from './imports.mjs';

// Builds the folder one host installs. A host that copies only its plugin folder (WorkBuddy), or loads every
// component folder at a plugin's root (WorkBuddy, Antigravity), or loads an npm package (OpenCode) cannot install
// this repo as it is: it would miss lib/ or load the Claude Code plugin's skill, commands and hooks. The folder holds
// the files the host's entries load, at their paths in this repo, and the host's manifests at its root, as
// hosts/<host>/dist/pack.json lists them:
//   { "entries": [repo files the host runs], "root": { "path in the folder": "repo file or folder" },
//     "patch": { "a JSON file in root": { fields to set } } }

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MODULE_PACKAGE = { private: true, type: 'module' };
// Written into every packed folder, so a later pack knows the folder is its own to replace.
const PACKED_MARK = '.evolver-packed';


/** The host's readers beside its profile, which the registry imports by name rather than by a static import. */
function profileFilesOf(host) {
  const dir = path.join(ROOT, 'hosts', host);
  return readdirSync(dir).filter((name) => /\.m?js$/.test(name) && statSync(path.join(dir, name)).isFile()).map((name) => `hosts/${host}/${name}`);
}

/**
 * Every repo file the entries load, followed through relative imports. A static package import is refused; a dynamic
 * one is the code's own fallback for a package that may be missing, so it is left out.
 */
export function closureOf(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = path.posix.normalize(queue.pop());
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { specifier, isDynamic } of importsOf(readFileSync(path.join(ROOT, file), 'utf8'))) {
      if (specifier.startsWith('node:') || (isDynamic && !specifier.startsWith('.'))) continue;
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

const isInside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// The folder is emptied first, so it must be one this script made, or new and empty, and never hold the repo.
function assertReplaceable(out) {
  const resolved = path.resolve(out);
  if (isInside(ROOT, resolved)) throw new Error(`Refusing to pack into ${resolved}: it holds this repository.`);
  if (!existsSync(resolved)) return;
  const isOwn = existsSync(path.join(resolved, PACKED_MARK)) || readdirSync(resolved).length === 0;
  if (!isOwn) throw new Error(`Refusing to pack into ${resolved}: it is not empty and was not made by scripts/pack.mjs.`);
}

/** Writes `host`'s folder into `out`, replacing an earlier pack there, and returns the repo files it took. */
export function pack(host, out) {
  const spec = packSpecOf(host);
  const files = closureOf([...spec.entries, ...profileFilesOf(host)]);
  assertReplaceable(out);
  rmSync(out, { recursive: true, force: true });
  for (const file of files) copied(path.join(ROOT, file), path.join(out, file));
  for (const [target, source] of Object.entries(spec.root ?? {})) copied(path.join(ROOT, source), path.join(out, target));
  if (!existsSync(path.join(out, 'package.json'))) writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(MODULE_PACKAGE, null, 2)}\n`);
  for (const [target, fields] of Object.entries(spec.patch ?? {})) patchJson(path.join(out, target), fields);
  writeFileSync(path.join(out, PACKED_MARK), `${host}\n`);
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
  try {
    for (const [name, folder] of targets) {
      pack(name, folder);
      console.log(`Packed ${name} into ${folder}.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

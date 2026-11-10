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
//     "patch": { "a JSON file in root": { fields to set } }, "vendors": ["smol-toml"] }

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MODULE_PACKAGE = { private: true, type: 'module' };
// Written into every packed folder, so a later pack knows the folder is its own to replace.
const PACKED_MARK = '.evolver-packed';
const TOML_VENDOR = { name: 'smol-toml', version: '1.9.1', type: 'module', license: 'BSD-3-Clause' };
const TOML_ROOT = 'lib/vendor/smol-toml';
const TOML_ENTRY = `${TOML_ROOT}/dist/index.js`;
const isVendorFile = (file) => file.startsWith(`${TOML_ROOT}/`);
const sourceOf = (file) => path.join(ROOT, isVendorFile(file) ? `node_modules/smol-toml/${file.slice(TOML_ROOT.length + 1)}` : file);

function checkVendorManifest() {
  const manifest = JSON.parse(readFileSync(sourceOf(`${TOML_ROOT}/package.json`), 'utf8'));
  if (Object.entries(TOML_VENDOR).some(([key, value]) => manifest[key] !== value)
    || manifest.exports?.import !== './dist/index.js' || Object.keys(manifest.dependencies ?? {}).length) {
    throw new Error('Expected the pinned smol-toml@1.9.1 ESM package; run npm ci before packing.');
  }
}


/** The host's readers beside its profile, which the registry imports by name rather than by a static import. */
function profileFilesOf(host) {
  const dir = path.join(ROOT, 'hosts', host);
  return readdirSync(dir).filter((name) => /\.m?js$/.test(name) && statSync(path.join(dir, name)).isFile()).map((name) => `hosts/${host}/${name}`);
}

/**
 * Every file the entries load, followed through relative imports. A host can opt in to the pinned TOML ESM package.
 * Other static package imports are refused, and optional dynamic package imports stay outside the bundle.
 */
export function closureOf(entries, vendors = []) {
  const optIn = Array.isArray(vendors) && vendors.length === 1 && vendors[0] === TOML_VENDOR.name;
  if (!optIn && (!Array.isArray(vendors) || vendors.length !== 0)) throw new Error('Unsupported packed host vendors.');
  if (entries.some((file) => isVendorFile(path.posix.normalize(file)))) throw new Error('A packed entry must be a repository file.');
  if (optIn) checkVendorManifest();
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = path.posix.normalize(queue.pop());
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { specifier, isDynamic } of importsOf(readFileSync(sourceOf(file), 'utf8'))) {
      if (specifier.startsWith('node:') || (isDynamic && !specifier.startsWith('.'))) continue;
      if (optIn && specifier === TOML_VENDOR.name && !isVendorFile(file)) {
        queue.push(TOML_ENTRY);
        seen.add(`${TOML_ROOT}/package.json`);
        seen.add(`${TOML_ROOT}/LICENSE`);
        continue;
      }
      if (!specifier.startsWith('.')) throw new Error(`${file} imports the package ${specifier}, which a packed host does not ship`);
      const dependency = path.posix.join(path.posix.dirname(file), specifier);
      if (isVendorFile(file) !== isVendorFile(dependency)) throw new Error(`Vendor imports must use the pinned package entry: ${file} -> ${specifier}`);
      queue.push(dependency);
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

function copyModule(file, out, includesVendor) {
  const target = path.join(out, file);
  if (file === `${TOML_ROOT}/package.json`) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(TOML_VENDOR, null, 2)}\n`);
    return;
  }
  copied(sourceOf(file), target);
  if (!includesVendor || isVendorFile(file) || !/\.m?js$/.test(file)) return;
  const source = readFileSync(target, 'utf8');
  let rewritten = source;
  for (const { specifier, isDynamic, offset } of importsOf(source).reverse()) {
    if (isDynamic || specifier !== TOML_VENDOR.name) continue;
    const relative = path.posix.relative(path.posix.dirname(file), TOML_ENTRY);
    const entry = relative.startsWith('.') ? relative : `./${relative}`;
    rewritten = rewritten.slice(0, offset) + entry + rewritten.slice(offset + specifier.length);
  }
  if (rewritten !== source) writeFileSync(target, rewritten);
}

const VERSION_FIELD = /("version"\s*:\s*")[^"]*(")/g;
const isManifest = (target) => /(?:^|\/)(?:kimi\.plugin|plugin|marketplace|package)\.json$/.test(target);

// A release names its version once, in its tag: every manifest the host reads its version from gets it here.
function stampVersion(out, targets, version) {
  for (const target of targets.filter(isManifest)) {
    const file = path.join(out, target);
    writeFileSync(file, readFileSync(file, 'utf8').replace(VERSION_FIELD, `$1${version}$2`));
  }
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

/**
 * Writes `host`'s folder into `out`, replacing an earlier pack there, and returns the repo files it took. With
 * `version`, every manifest in the folder names that version.
 */
export function pack(host, out, { version = null } = {}) {
  const spec = packSpecOf(host);
  const files = closureOf([...spec.entries, ...profileFilesOf(host)], spec.vendors);
  assertReplaceable(out);
  rmSync(out, { recursive: true, force: true });
  const includesVendor = files.includes(TOML_ENTRY);
  for (const file of files) copyModule(file, out, includesVendor);
  for (const [target, source] of Object.entries(spec.root ?? {})) copied(path.join(ROOT, source), path.join(out, target));
  if (!existsSync(path.join(out, 'package.json'))) writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(MODULE_PACKAGE, null, 2)}\n`);
  for (const [target, fields] of Object.entries(spec.patch ?? {})) patchJson(path.join(out, target), fields);
  if (version) stampVersion(out, Object.keys(spec.root ?? {}), version);
  if (version) patchJson(path.join(out, 'package.json'), { version });
  writeFileSync(path.join(out, PACKED_MARK), `${host}\n`);
  return files;
}

/** The hosts that install a packed folder: those with a hosts/<host>/dist/pack.json. */
export function packedHosts() {
  return readdirSync(path.join(ROOT, 'hosts')).filter((host) => existsSync(path.join(ROOT, 'hosts', host, 'dist', 'pack.json'))).sort();
}

// `all` packs every such host into <output folder>/<host>, the layout the repo's marketplaces point at.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [host, out, versionArgument] = process.argv.slice(2);
  const version = versionArgument?.replace(/^--version=v?/, '') ?? null;
  const isVersion = version === null || /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
  if (!host || !out || !isVersion) {
    console.error('Usage: node scripts/pack.mjs <host | all> <output folder> [--version=X.Y.Z]');
    process.exit(2);
  }
  const targets = host === 'all' ? packedHosts().map((name) => [name, path.resolve(out, name)]) : [[host, path.resolve(out)]];
  try {
    for (const [name, folder] of targets) {
      pack(name, folder, { version });
      console.log(`Packed ${name}${version ? ` ${version}` : ''} into ${folder}.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

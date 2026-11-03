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
// These bytes are needed by the shared runtime, including npm hosts whose package manager omits node_modules.
// Keep the allowlist exact: optional SDKs and engine packages are still not part of a host bundle.
const VENDORS = { 'smol-toml': { version: '1.9.1', license: 'BSD-3-Clause', entry: 'dist/index.js', root: 'lib/vendor/smol-toml' } };
const vendorOf = file => Object.entries(VENDORS).find(([, vendor]) => file.startsWith(`${vendor.root}/`));
const sourceOf = file => {
  const vendor = vendorOf(file);
  return path.join(ROOT, vendor ? `node_modules/${vendor[0]}/${file.slice(vendor[1].root.length + 1)}` : file);
};

function vendorManifest(name, vendor) {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));
  if (manifest.name !== name || manifest.version !== vendor.version || manifest.license !== vendor.license
    || manifest.type !== 'module' || manifest.exports?.import !== `./${vendor.entry}` || Object.keys(manifest.dependencies ?? {}).length) throw new Error(`Expected the pinned ${name}@${vendor.version} ESM package; run npm ci before packing.`);
  return { name, version: manifest.version, type: manifest.type, license: manifest.license };
}

/** The host's readers beside its profile, which the registry imports by name rather than by a static import. */
function profileFilesOf(host) {
  const dir = path.join(ROOT, 'hosts', host);
  return readdirSync(dir).filter((name) => /\.m?js$/.test(name) && statSync(path.join(dir, name)).isFile()).map((name) => `hosts/${host}/${name}`);
}

/**
 * Every file the entries load, followed through relative imports, at its path inside the bundle. Static packages
 * are refused except the exact vendored ESM allowlist; dynamic package fallbacks remain outside the bundle.
 */
export function closureOf(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = path.posix.normalize(queue.pop());
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { specifier, isDynamic } of importsOf(readFileSync(sourceOf(file), 'utf8'))) {
      if (specifier.startsWith('node:') || (isDynamic && !specifier.startsWith('.'))) continue;
      if (!specifier.startsWith('.')) {
        const vendor = VENDORS[specifier];
        if (!vendor) throw new Error(`${file} imports the package ${specifier}, which a packed host does not ship`);
        vendorManifest(specifier, vendor);
        queue.push(`${vendor.root}/${vendor.entry}`);
        seen.add(`${vendor.root}/package.json`); seen.add(`${vendor.root}/LICENSE`);
      } else {
        const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        const vendor = vendorOf(file);
        if (dependency.startsWith('../') || path.posix.isAbsolute(dependency) || (vendor && !dependency.startsWith(`${vendor[1].root}/`))) throw new Error(`Import escapes its package: ${file} -> ${specifier}`);
        queue.push(dependency);
      }
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

const VERSION_FIELD = /("version"\s*:\s*")[^"]*(")/g;
const isManifest = (target) => /(?:^|\/)(?:kimi\.plugin|plugin|marketplace|package)\.json$/.test(target);

function copyModule(file, out) {
  const vendor = vendorOf(file), target = path.join(out, file);
  if (vendor && file === `${vendor[1].root}/package.json`) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(vendorManifest(...vendor), null, 2)}\n`);
    return;
  }
  copied(sourceOf(file), target);
  if (!/\.m?js$/.test(file)) return;
  const source = readFileSync(target, 'utf8');
  const rewritten = source.replace(/(\bfrom\s*|\bimport\s*)(['"])smol-toml\2/g, (_, prefix) => {
    const relative = path.posix.relative(path.posix.dirname(file), `${VENDORS['smol-toml'].root}/${VENDORS['smol-toml'].entry}`);
    return `${prefix}${JSON.stringify(relative.startsWith('.') ? relative : `./${relative}`)}`;
  });
  if (source !== rewritten) writeFileSync(target, rewritten);
}

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
  const files = closureOf([...spec.entries, ...profileFilesOf(host)]);
  assertReplaceable(out);
  rmSync(out, { recursive: true, force: true });
  for (const file of files) copyModule(file, out);
  for (const [target, source] of Object.entries(spec.root ?? {})) copied(path.join(ROOT, source), path.join(out, target));
  if (!existsSync(path.join(out, 'package.json'))) writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(MODULE_PACKAGE, null, 2)}\n`);
  for (const [target, fields] of Object.entries(spec.patch ?? {})) patchJson(path.join(out, target), fields);
  if (version) stampVersion(out, Object.keys(spec.root ?? {}), version);
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

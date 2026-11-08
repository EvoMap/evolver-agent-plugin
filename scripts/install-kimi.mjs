#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { updateState } from '../lib/runtime/store/file-lock.js';
import { kimiHomeOf } from '../hosts/kimi/paths.js';
import { pack } from './pack.mjs';

const BUNDLE = fileURLToPath(new URL('../dist/kimi', import.meta.url));
const NAME = 'evolver-plugin';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
function validVersion(value) {
  const parts = typeof value === 'string' && VERSION.exec(value);
  return Boolean(parts && !parts[4]?.split('.').some(part => /^0\d+$/.test(part)));
}

function isOlderVersion(candidate, installed) {
  const [, ...next] = VERSION.exec(candidate);
  const [, ...current] = VERSION.exec(installed);
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== current[index]) return BigInt(next[index]) < BigInt(current[index]);
  }
  if (!next[3] || !current[3]) return Boolean(next[3] && !current[3]);
  const left = next[3].split('.'), right = current[3].split('.');
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index], b = right[index];
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a), bNumeric = /^\d+$/.test(b);
    if (aNumeric !== bNumeric) return aNumeric;
    return aNumeric ? BigInt(a) < BigInt(b) : a < b;
  }
  return left.length < right.length;
}

function ordinaryDirectory(path) {
  if (!fs.existsSync(path)) return;
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing a non-directory or linked plugin path: ${path}`);
}

function validRegistry(value) {
  if (value?.version !== 1 || !Array.isArray(value.plugins)
    || value.plugins.some(entry => !entry || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.root !== 'string')
    || new Set(value.plugins.map(entry => entry.id)).size !== value.plugins.length) throw new Error('Invalid Kimi plugin registry; repair it before retrying.');
  return value;
}

function registryOf(file) {
  let value;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing a non-file or linked plugin registry.');
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, plugins: [] };
    throw error;
  }
  return validRegistry(value);
}

function packageOf(dir) {
  if (!fs.existsSync(dir)) return null;
  ordinaryDirectory(dir);
  const marker = join(dir, '.evolver-packed'), file = join(dir, 'kimi.plugin.json');
  for (const path of [marker, file]) {
    if (!fs.existsSync(path) || !fs.lstatSync(path).isFile() || fs.lstatSync(path).isSymbolicLink()) throw new Error(`Refusing an unmanaged Kimi plugin: ${dir}`);
  }
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (fs.readFileSync(marker, 'utf8').trim() !== 'kimi' || manifest.name !== NAME || !validVersion(manifest.version)
    || !Array.isArray(manifest.hooks) || manifest.hooks.some(hook => typeof hook.event !== 'string' || typeof hook.command !== 'string')) throw new Error(`Invalid Kimi package identity, version or hooks: ${dir}`);
  return manifest;
}

function ownEntry(registry, target) {
  const own = registry.plugins.find(entry => entry.id === NAME);
  if (own && resolve(own.root) !== target) throw new Error('Refusing to replace an Evolver registration owned by another path.');
  return own;
}

function underInstallLock(plugins, work) {
  let result;
  // No state value is written: this target-specific guard must stay held through registry failure and rollback.
  updateState(join(plugins, '.evolver-plugin-install'), {}, () => { result = work(); });
  return result;
}

// A rollback can remove the new target before restoring the backup, leaving only "previous" in staging.
function recoverPackage(root, target) {
  let interrupted;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\.evolver-install-[a-z0-9]{6}$/i.test(entry.name)) continue;
    const stage = join(root, entry.name);
    ordinaryDirectory(stage);
    const backup = join(stage, 'previous'), prepared = join(stage, 'package');
    const previous = packageOf(backup);
    if (!previous) continue;
    packageOf(prepared);
    if (interrupted) throw new Error('Multiple interrupted Kimi updates found. Restore the intended backup before retrying.');
    interrupted = { stage, backup, prepared, previous };
  }
  if (!interrupted) return null;
  fs.renameSync(interrupted.backup, target);
  fs.rmSync(interrupted.prepared, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (fs.readdirSync(interrupted.stage).length === 0) fs.rmdirSync(interrupted.stage);
  return interrupted.previous;
}

function installationOf(root, target, registryFile, recover = false) {
  const own = ownEntry(registryOf(registryFile), target);
  const previous = packageOf(target) ?? (recover && own ? recoverPackage(root, target) : null);
  return { own, previous };
}

/** Installs only the owned managed package and native registry entry; account/config/state stay outside them. */
export function installKimi({ operation = 'install', home = kimiHomeOf(process.env), dryRun = false, version } = {}) {
  if (!['install', 'update', 'status', 'remove'].includes(operation)) throw new Error('Expected install, update, status or remove.');
  if (version !== undefined && (!validVersion(version) || !['install', 'update'].includes(operation))) throw new Error('Version must be X.Y.Z or X.Y.Z-prerelease for install/update.');
  const root = resolve(home), plugins = join(root, 'plugins'), managed = join(plugins, 'managed'), target = join(managed, 'evolver-plugin');
  for (const dir of [root, plugins, managed, target]) ordinaryDirectory(dir);
  const registryFile = join(plugins, 'installed.json');
  if (operation === 'remove' && !dryRun) return underInstallLock(plugins, () => {
    const packageRetained = Boolean(installationOf(root, target, registryFile, true).previous);
    updateState(registryFile, { version: 1, plugins: [] }, current => {
      validRegistry(current);
      if (!ownEntry(current, target)) return undefined;
      return { ...current, plugins: current.plugins.filter(entry => entry.id !== NAME) };
    });
    // Native removal unregisters the plugin and retains its managed bytes.
    return { installed: false, registered: false, path: target, packageRetained };
  });
  let { own, previous } = installationOf(root, target, registryFile);
  if (!dryRun && own && !previous) {
    ({ own, previous } = underInstallLock(plugins, () => installationOf(root, target, registryFile, true)));
  }
  const registered = Boolean(own), installed = registered && Boolean(previous);
  if (operation === 'status') return { installed, registered, path: target, ...(previous ? { version: previous.version } : {}), ...(own ? { enabled: own.enabled !== false } : {}) };
  if (operation === 'update' && !installed) throw new Error('Kimi plugin is not installed; use install first.');
  if (dryRun) return { operation, path: target, dryRun: true };
  fs.mkdirSync(managed, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(join(root, '.evolver-install-')), prepared = join(stage, 'package'), backup = join(stage, 'previous');
  let moved = false, activated = false, committed = false, next;
  try {
    if (version === undefined && fs.existsSync(BUNDLE)) {
      packageOf(BUNDLE);
      fs.cpSync(BUNDLE, prepared, { recursive: true });
    } else pack('kimi', prepared, { version });
    next = packageOf(prepared);
    underInstallLock(plugins, () => {
      try {
        updateState(registryFile, { version: 1, plugins: [] }, current => {
          validRegistry(current);
          const currentOwn = ownEntry(current, target);
          const currentPackage = packageOf(target) ?? (currentOwn ? recoverPackage(root, target) : null);
          if (operation === 'update' && (!currentOwn || !currentPackage)) throw new Error('Kimi plugin changed before activation; retry after checking status.');
          if (version === undefined && currentPackage && isOlderVersion(next.version, currentPackage.version)) {
            throw new Error(`Refusing to downgrade Kimi plugin from ${currentPackage.version} to ${next.version}. Use a current bundle or specify --version to build the checkout intentionally.`);
          }
          if (currentPackage) { fs.renameSync(target, backup); moved = true; }
          fs.renameSync(prepared, target); activated = true;
          const entry = { ...currentOwn, id: NAME, root: target, source: 'local-path', enabled: currentOwn?.enabled ?? true, installedAt: currentOwn?.installedAt ?? new Date().toISOString() };
          return { ...current, plugins: [...current.plugins.filter(item => item.id !== NAME), entry] };
        });
        committed = true;
      } catch (error) {
        try {
          if (activated) fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          if (moved) { fs.renameSync(backup, target); moved = false; }
        } catch { throw new Error(`Activation and rollback failed. The previous package is retained at ${backup}.`); }
        throw error;
      }
    });
    return { installed: true, registered: true, operation, path: target, version: next.version, next: 'Start a new Kimi Code session to load the managed plugin.' };
  } finally {
    if (!moved || committed) fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ options: { home: { type: 'string' }, 'dry-run': { type: 'boolean' }, version: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: true });
    const usage = 'Usage: node scripts/install-kimi.mjs [install|update|status|remove] [--home PATH] [--dry-run] [--version X.Y.Z]';
    if (positionals.length > 1) throw new Error(usage);
    if (values.help) console.log(usage);
    else console.log(JSON.stringify(installKimi({ operation: positionals[0], home: values.home, dryRun: values['dry-run'], version: values.version }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

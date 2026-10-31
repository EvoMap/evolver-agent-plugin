#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { dataDirOf } from '../hosts/minimax/paths.js';
import { pack } from './pack.mjs';

const BUNDLE = fileURLToPath(new URL('../dist/minimax', import.meta.url));
const validVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)
  && !value.split('-').slice(1).join('-').split('.').some(part => /^0\d+$/.test(part));

function ordinaryDirectory(dir) {
  if (!existsSync(dir)) return;
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing a non-directory or linked plugin path: ${dir}`);
}

/** Replaces only this tool's packed package; native PLUGIN_DATA and account configuration stay outside it. */
export function installMiniMax({ operation = 'install', dataDir = dataDirOf(process.env), dryRun = false, version } = {}) {
  if (!['install', 'update', 'status'].includes(operation)) throw new Error('Expected install, update or status.');
  if (version !== undefined && !validVersion(version)) throw new Error('Version must be X.Y.Z or X.Y.Z-prerelease.');
  const root = resolve(dataDir), plugins = join(root, 'plugins'), target = join(plugins, 'evolver-plugin');
  for (const dir of [root, plugins, target]) ordinaryDirectory(dir);
  const installed = existsSync(target);
  if (installed) {
    const marker = join(target, '.evolver-packed');
    if (!existsSync(marker) || readFileSync(marker, 'utf8').trim() !== 'minimax') throw new Error(`Refusing to replace an unmanaged plugin: ${target}`);
    const manifest = JSON.parse(readFileSync(join(target, '.minimax-plugin/plugin.json'), 'utf8'));
    if (manifest.name !== 'evolver-plugin') throw new Error('Installed plugin identity does not match.');
    if (operation === 'status') return { installed: true, path: target, version: manifest.version };
  } else {
    if (operation === 'status') return { installed: false, path: target };
    if (operation === 'update') throw new Error('MiniMax plugin is not installed; use install first.');
  }
  if (dryRun) return { operation, path: target, dryRun: true };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(plugins, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(root, '.evolver-install-'));
  const prepared = join(stage, 'package'), backup = join(stage, 'previous');
  let moved = false, committed = false;
  try {
    if (version === undefined && existsSync(BUNDLE)) {
      ordinaryDirectory(BUNDLE);
      const manifest = JSON.parse(readFileSync(join(BUNDLE, '.minimax-plugin/plugin.json'), 'utf8'));
      if (readFileSync(join(BUNDLE, '.evolver-packed'), 'utf8').trim() !== 'minimax' || manifest.name !== 'evolver-plugin' || !validVersion(manifest.version)) throw new Error('The bundled MiniMax package has an invalid identity or version; rebuild it before installing.');
      cpSync(BUNDLE, prepared, { recursive: true });
    } else pack('minimax', prepared, { version });
    if (installed) { renameSync(target, backup); moved = true; }
    try { renameSync(prepared, target); }
    catch (error) {
      if (moved) {
        try { renameSync(backup, target); moved = false; }
        catch { throw new Error(`Activation and rollback failed. The previous package is retained at ${backup}.`); }
      }
      throw error;
    }
    committed = true;
    return { installed: true, operation, path: target, next: 'mcode plugin enable evolver-plugin@local --json; start a new task to load the package.' };
  } finally {
    // Keep the backup if a filesystem failure also prevented rollback.
    if (!moved || committed) rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ options: { 'data-dir': { type: 'string' }, 'dry-run': { type: 'boolean' }, version: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: true });
    const usage = 'Usage: node scripts/install-minimax.mjs [install|update|status] [--data-dir PATH] [--dry-run] [--version X.Y.Z]';
    if (positionals.length > 1) throw new Error(usage);
    if (values.help) console.log(usage);
    else console.log(JSON.stringify(installMiniMax({ operation: positionals[0], dataDir: values['data-dir'], dryRun: values['dry-run'], version: values.version }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

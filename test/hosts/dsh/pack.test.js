import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { importsOf } from '../../../scripts/imports.mjs';
import { closureOf, packSpecOf } from '../../../scripts/pack.mjs';
import { resolvedPackage } from './host.js';

const MAX_ICON_BYTES = 256 * 1024;

function filesIn(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesIn(join(dir, entry.name), root) : [relative(root, join(dir, entry.name))]));
}

test('the packed folder is the @evomap/dsh-evolver package dsh installs: its entry, bundle patch, display name and icon', () => {
  const { main, manifestPath, dir } = resolvedPackage();
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.name, '@evomap/dsh-evolver');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.peerDependencies, undefined);
  assert.equal(relative(dir, main), 'hosts/dsh/dist/plugin.mjs');
  const patch = readFileSync(join(dir, manifest.dsh.bundle.patch), 'utf8');
  assert.match(patch, /^- insert:\n {4}- id: evolver\n {6}name: '@evomap\/dsh-evolver'$/m);
  for (const locale of ['en', 'zh-CN']) {
    const { meta } = JSON.parse(readFileSync(join(dir, manifest.exports['./locale/*'].replace('*', `${locale}.json`)), 'utf8'));
    assert.equal(meta.title, 'evolver-plugin');
    assert.ok(meta.description.length > 0);
  }
  assert.ok(statSync(join(dir, manifest.icon)).size <= MAX_ICON_BYTES);
  for (const entry of manifest.files) assert.ok(existsSync(join(dir, entry)), entry);
});

test('the packed folder holds the plugin channel and what it loads, and nothing of another channel', () => {
  const { dir } = resolvedPackage();
  const files = filesIn(dir);
  assert.ok(files.includes('hosts/dsh/profile.js'));
  assert.ok(files.includes('lib/channels/plugin/adapter.js'));
  assert.deepEqual(files.filter((file) => /^(?:lib\/channels\/(?:mcp|hook|script|relay|worker)|bin|hosts\/(?!dsh\/))/.test(file)), []);
  const imported = files.filter((file) => /\.m?js$/.test(file)).flatMap((file) => importsOf(readFileSync(join(dir, file), 'utf8')).map(({ specifier }) => specifier));
  assert.deepEqual(imported.filter((specifier) => specifier.startsWith('@deepseek-ai/')), [], 'no dsh package is imported, so any dsh line loads it');
});

test('a checkout loads as a path plugin from hosts/dsh/dist, whose exports stay inside it', () => {
  const checkout = fileURLToPath(new URL('../../../hosts/dsh/dist/', import.meta.url));
  const manifest = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
  assert.equal(manifest.exports['.'], './plugin.mjs');
  assert.ok(existsSync(join(checkout, manifest.dsh.bundle.patch)));
  assert.ok(existsSync(join(checkout, 'locale', 'en.json')));
  assert.ok(closureOf(packSpecOf('dsh').entries).every((file) => !file.startsWith('..')));
});

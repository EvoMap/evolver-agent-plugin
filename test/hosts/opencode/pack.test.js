import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { closureOf, pack, packSpecOf } from '../../../scripts/pack.mjs';

function packed(t) {
  const out = mkdtempSync(join(tmpdir(), 'evolver-opencode-pack-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  return { out, files: pack('opencode', out) };
}

test('the published folder holds the two OpenCode entries and what they load, and nothing of the MCP channel', (t) => {
  const { out, files } = packed(t);
  const manifest = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@evomap/evolver-opencode');
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.engines.opencode, '>=1.19.4');
  assert.equal(manifest.dependencies, undefined);
  for (const entry of [manifest.exports['./server'], manifest.exports['./tui']]) assert.ok(existsSync(join(out, entry)), entry);
  assert.ok(files.includes('hosts/opencode/profile.js'));
  assert.ok(files.includes('lib/channels/plugin/adapter.js'));
  assert.deepEqual(files.filter((file) => /^(lib\/channels\/(mcp|hook|script)|lib\/claude-code|hooks|bin)\//.test(file)), []);
  assert.equal(files.some((file) => readFileSync(join(out, file), 'utf8').includes('@modelcontextprotocol')), false);
});

test('the packed entries load as OpenCode plugin modules', async (t) => {
  const { out } = packed(t);
  const manifest = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
  const server = (await import(pathToFileURL(join(out, manifest.exports['./server'])).href)).default;
  const tui = (await import(pathToFileURL(join(out, manifest.exports['./tui'])).href)).default;
  assert.deepEqual([server.id, typeof server.server, server.tui], ['evomap.evolver', 'function', undefined]);
  assert.deepEqual([tui.id, typeof tui.tui, tui.server], ['evomap.evolver', 'function', undefined]);
});

test('a checkout loads as a path plugin from hosts/opencode/dist, whose exports stay inside it', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../hosts/opencode/dist/package.json', import.meta.url), 'utf8'));
  assert.deepEqual([manifest.exports['./server'], manifest.exports['./tui']], ['./server.mjs', './tui.mjs']);
  assert.ok(closureOf(packSpecOf('opencode').entries).every((file) => !file.startsWith('..')));
});

test('a pack never empties a folder it did not make, nor one holding the repository', (t) => {
  const mine = mkdtempSync(join(tmpdir(), 'evolver-pack-guard-'));
  t.after(() => rmSync(mine, { recursive: true, force: true }));
  writeFileSync(join(mine, 'notes.txt'), 'keep me');
  assert.throws(() => pack('opencode', mine), /not empty and was not made by scripts\/pack\.mjs/);
  assert.equal(readFileSync(join(mine, 'notes.txt'), 'utf8'), 'keep me');
  assert.throws(() => pack('opencode', fileURLToPath(new URL('../../../', import.meta.url))), /holds this repository/);
  assert.throws(() => pack('opencode', fileURLToPath(new URL('../../../../', import.meta.url))), /holds this repository/);
  const again = mkdtempSync(join(tmpdir(), 'evolver-pack-again-'));
  t.after(() => rmSync(again, { recursive: true, force: true }));
  pack('opencode', again);
  assert.doesNotThrow(() => pack('opencode', again));
});

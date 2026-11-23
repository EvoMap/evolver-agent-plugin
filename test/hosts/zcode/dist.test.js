import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { packedHosts } from '../../../scripts/pack.mjs';

const json = (path) => JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'));
const DIST = 'hosts/zcode/dist';

test('the ZCode marketplace installs dist/zcode from the release branch under ZCode\'s own manifest folder', () => {
  const marketplace = json('.zcode-plugin/marketplace.json');
  const manifest = json(`${DIST}/plugin.json`);
  const [entry, ...rest] = marketplace.plugins;
  assert.deepEqual(rest, []);
  assert.deepEqual(entry.source, { source: 'git-subdir', url: 'https://github.com/EvoMap/evolver-agent-plugin.git', path: 'dist/zcode', ref: 'release' });
  assert.ok(packedHosts().includes('zcode'));
  assert.equal(entry.name, manifest.name);
  assert.equal('version' in entry, false, 'the packed manifest carries the release tag\'s version');
  assert.equal(`${entry.name}@${marketplace.name}`, 'evolver-plugin@evomap');
});

test('the local marketplace packed into dist/zcode keeps its own name, so it never shadows the GitHub one', () => {
  const local = json(`${DIST}/marketplace.json`);
  assert.equal(local.name, 'evolver-zcode-local');
  assert.notEqual(local.name, json('.zcode-plugin/marketplace.json').name);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { pack } from '../scripts/pack.mjs';

function filesOf(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesOf(root, path) : [relative(root, path)];
  }).sort();
}

test('packing deterministically vendors only the pinned TOML ESM closure and its license', t => {
  const root = mkdtempSync(join(tmpdir(), 'evolver-pack-vendor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const left = join(root, 'left'), right = join(root, 'right');
  const files = pack('kimi', left, { version: '9.8.7' });
  pack('kimi', right, { version: '9.8.7' });
  const vendor = join(left, 'lib', 'vendor', 'smol-toml');
  assert.deepEqual(JSON.parse(readFileSync(join(vendor, 'package.json'), 'utf8')), {
    name: 'smol-toml', version: '1.9.1', type: 'module', license: 'BSD-3-Clause',
  });
  assert.equal(readFileSync(join(vendor, 'LICENSE'), 'utf8'), readFileSync(new URL('../node_modules/smol-toml/LICENSE', import.meta.url), 'utf8'));
  assert.ok(files.includes('lib/vendor/smol-toml/dist/index.js'));
  assert.ok(files.every(file => !file.startsWith('node_modules/')));
  assert.equal(existsSync(join(left, 'node_modules')), false);
  assert.equal(existsSync(join(vendor, 'dist', 'index.cjs')), false);
  assert.equal(existsSync(join(vendor, 'README.md')), false);
  const config = readFileSync(join(left, 'lib', 'runtime', 'native-config.js'), 'utf8');
  assert.match(config, /from ["']\.\.\/vendor\/smol-toml\/dist\/index\.js["']/);
  assert.doesNotMatch(config, /from ["']smol-toml["']/);
  const snapshot = dir => filesOf(dir).map(file => [file, createHash('sha256').update(readFileSync(join(dir, file))).digest('hex')]);
  assert.deepEqual(snapshot(left), snapshot(right));
});

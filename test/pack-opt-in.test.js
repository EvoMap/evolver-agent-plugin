import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('only an opted-in host packs and runs the pinned TOML ESM module', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'evolver-pack-toml-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = join(root, 'hosts', 'fixture');
  mkdirSync(join(host, 'dist'), { recursive: true });
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  mkdirSync(join(root, 'scripts'));
  for (const file of ['pack.mjs', 'imports.mjs']) {
    cpSync(fileURLToPath(new URL('../scripts/' + file, import.meta.url)), join(root, 'scripts', file));
  }
  cpSync(fileURLToPath(new URL('../node_modules/smol-toml', import.meta.url)), join(root, 'node_modules', 'smol-toml'), { recursive: true });
  writeFileSync(join(host, 'model.mjs'), [
    "import { parse } from 'smol-toml';",
    'export const result = parse(' + JSON.stringify('[model]\nname = "kimi"') + ');',
    "export const prose = \"import 'smol-toml'\";",
  ].join('\n'));
  const spec = join(host, 'dist', 'pack.json'), out = join(root, 'bundle');
  const { pack } = await import(pathToFileURL(join(root, 'scripts', 'pack.mjs')));
  writeFileSync(spec, JSON.stringify({ entries: [] }));
  assert.throws(() => pack('fixture', out), /packed host does not ship/);
  writeFileSync(spec, JSON.stringify({ entries: [], vendors: ['other-package'] }));
  assert.throws(() => pack('fixture', out), /Unsupported packed host vendors/);
  writeFileSync(spec, JSON.stringify({ entries: [], vendors: ['smol-toml'] }));
  const packed = pack('fixture', out);
  assert.ok(packed.includes('lib/vendor/smol-toml/dist/index.js'));
  assert.equal(existsSync(join(out, 'node_modules')), false);
  assert.equal(existsSync(join(out, 'lib', 'vendor', 'smol-toml', 'dist', 'index.cjs')), false);
  const license = readFileSync(join(out, 'lib', 'vendor', 'smol-toml', 'LICENSE'), 'utf8');
  assert.equal(license, readFileSync(join(root, 'node_modules', 'smol-toml', 'LICENSE'), 'utf8'));
  const entry = join(out, 'hosts', 'fixture', 'model.mjs');
  assert.match(readFileSync(entry, 'utf8'), /from '\.\.\/\.\.\/lib\/vendor\/smol-toml\/dist\/index\.js'/);
  const module = await import(pathToFileURL(entry));
  assert.equal(module.result.model.name, 'kimi');
  assert.equal(module.prose, "import 'smol-toml'");
});

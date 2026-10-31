import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

import { installMiniMax } from '../../../scripts/install-minimax.mjs';
import { pack } from '../../../scripts/pack.mjs';

test('the default installer copies the released bundle and its version; an explicit version builds the checkout', t => {
  const root = mkdtempSync(join(tmpdir(), "evolver release user's "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout'), dataDir = join(root, 'native');
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  for (const file of ['bin', 'lib', 'scripts', 'hosts/minimax', '.minimax-plugin', 'assets', 'LICENSE', 'package.json']) {
    mkdirSync(dirname(join(checkout, file)), { recursive: true });
    cpSync(join(repository, file), join(checkout, file), { recursive: true });
  }
  const bundle = join(checkout, 'dist/minimax');
  pack('minimax', bundle, { version: '9.8.7' });
  writeFileSync(join(bundle, 'README.md'), 'The release guide for 9.8.7.\n');
  const run = (operation, ...args) => JSON.parse(execFileSync(process.execPath,
    [join(checkout, 'scripts/install-minimax.mjs'), operation, '--data-dir', dataDir, ...args], { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const installed = run('install');
  assert.equal(run('status').version, '9.8.7');
  assert.equal(readFileSync(join(installed.path, 'README.md'), 'utf8'), 'The release guide for 9.8.7.\n');
  const state = join(dataDir, 'v2/plugin-data/hooks/evolver-plugin');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'minimax-settings.json'), '{"recall":false}');
  writeFileSync(join(state, 'minimax-distill-drafts.json'), '[{"title":"keep this draft"}]');
  pack('minimax', bundle, { version: '9.8.8' });
  run('update');
  assert.equal(run('status').version, '9.8.8');
  assert.equal(readFileSync(join(state, 'minimax-settings.json'), 'utf8'), '{"recall":false}');
  assert.equal(readFileSync(join(state, 'minimax-distill-drafts.json'), 'utf8'), '[{"title":"keep this draft"}]');
  run('update', '--version', '10.0.0');
  assert.equal(run('status').version, '10.0.0');
  assert.equal(readFileSync(join(installed.path, 'README.md'), 'utf8'), readFileSync(join(checkout, 'hosts/minimax/dist/README.md'), 'utf8'));
  const manifestFile = join(bundle, '.minimax-plugin/plugin.json');
  const released = JSON.parse(readFileSync(manifestFile, 'utf8'));
  for (const invalid of [{ name: 'another-plugin' }, { version: 'not-a-version' }]) {
    writeFileSync(manifestFile, JSON.stringify({ ...released, ...invalid }));
    assert.throws(() => run('update'), /invalid identity or version/);
    assert.equal(run('status').version, '10.0.0');
  }
  writeFileSync(manifestFile, JSON.stringify(released));
  writeFileSync(join(bundle, '.evolver-packed'), 'grok\n');
  assert.throws(() => run('update'), /invalid identity or version/);
  assert.equal(run('status').version, '10.0.0');
  assert.equal(readdirSync(dataDir).some(name => name.startsWith('.evolver-install-')), false);
});

test('install and update replace the owned package while preserving native account data, preferences and drafts', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'evolver-install-native-'));
  try {
    const state = join(dataDir, 'v2/plugin-data/hooks/evolver-plugin'); mkdirSync(state, { recursive: true });
    writeFileSync(join(state, 'minimax-settings.json'), '{"autoDistill":false}');
    writeFileSync(join(state, 'minimax-distill-drafts.json'), '[{"title":"keep this draft"}]');
    writeFileSync(join(dataDir, 'config.yaml'), 'synthetic native account config');
    const dry = installMiniMax({ dataDir, dryRun: true });
    assert.equal(existsSync(dry.path), false);
    const installed = installMiniMax({ dataDir, version: '1.2.3' });
    assert.equal(readFileSync(join(installed.path, '.evolver-packed'), 'utf8').trim(), 'minimax');
    writeFileSync(join(installed.path, 'old-package-file'), 'remove during update');
    installMiniMax({ dataDir, operation: 'update', version: '1.2.4' });
    assert.equal(existsSync(join(installed.path, 'old-package-file')), false);
    assert.equal(readFileSync(join(state, 'minimax-settings.json'), 'utf8'), '{"autoDistill":false}');
    assert.equal(readFileSync(join(state, 'minimax-distill-drafts.json'), 'utf8'), '[{"title":"keep this draft"}]');
    assert.equal(readFileSync(join(dataDir, 'config.yaml'), 'utf8'), 'synthetic native account config');
    assert.equal(installMiniMax({ dataDir, operation: 'status' }).installed, true);
    assert.equal(installMiniMax({ dataDir, operation: 'status' }).version, '1.2.4');
    assert.equal(readdirSync(dataDir).some(name => name.startsWith('.evolver-install-')), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('an existing unmanaged plugin is never replaced and an absent update never creates one', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'evolver-unmanaged-native-'));
  try {
    assert.throws(() => installMiniMax({ dataDir, version: '1.02.3' }), /Version/);
    assert.throws(() => installMiniMax({ dataDir, operation: 'update' }), /not installed/);
    const target = join(dataDir, 'plugins/evolver-plugin'); mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'personal-file'), 'keep');
    assert.throws(() => installMiniMax({ dataDir }), /unmanaged/);
    assert.equal(readFileSync(join(target, 'personal-file'), 'utf8'), 'keep');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('an update which cannot activate the prepared package restores the previous package', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'evolver-rollback-native-'));
  const originalRename = fs.renameSync;
  try {
    const installed = installMiniMax({ dataDir });
    writeFileSync(join(installed.path, 'keep-on-failure'), 'previous package');
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (String(from).endsWith(`${process.platform === 'win32' ? '\\' : '/'}package`) && to === installed.path) throw new Error('fixture activation failure');
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    assert.throws(() => installMiniMax({ dataDir, operation: 'update' }), /activation failure/);
    assert.equal(readFileSync(join(installed.path, 'keep-on-failure'), 'utf8'), 'previous package');
    assert.equal(readdirSync(dataDir).some(name => name.startsWith('.evolver-install-')), false);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

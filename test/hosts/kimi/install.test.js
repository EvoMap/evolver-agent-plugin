import assert from 'node:assert/strict';
import fs, { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { installKimi } from '../../../scripts/install-kimi.mjs';
import { pack } from '../../../scripts/pack.mjs';

function scratch(t) {
  const home = mkdtempSync(join(tmpdir(), 'evolver-kimi-install-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('status does not create registration or change native account configuration', t => {
  const home = scratch(t);
  writeFileSync(join(home, 'config.toml'), 'default_model = "personal"\n');
  mkdirSync(join(home, 'credentials'));
  writeFileSync(join(home, 'credentials', 'personal.json'), '{"fixture":"keep"}');
  assert.deepEqual(installKimi({ operation: 'status', home }), {
    installed: false, registered: false, path: join(home, 'plugins', 'managed', 'evolver-plugin'),
  });
  assert.equal(existsSync(join(home, 'plugins')), false);
  assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), 'default_model = "personal"\n');
  assert.equal(readFileSync(join(home, 'credentials', 'personal.json'), 'utf8'), '{"fixture":"keep"}');
});

test('the terminal installer honors KIMI_CODE_HOME without creating a native profile', t => {
  const home = scratch(t), selected = join(home, 'selected profile');
  const script = fileURLToPath(new URL('../../../scripts/install-kimi.mjs', import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [script, 'status'], {
    cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, KIMI_CODE_HOME: selected }, encoding: 'utf8',
  }));
  assert.equal(result.path, join(selected, 'plugins', 'managed', 'evolver-plugin'));
  assert.equal(result.installed, false);
  assert.equal(existsSync(selected), false);
  assert.throws(() => execFileSync(process.execPath, [script, 'status', '--version', '1.2.3'], { cwd: home, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /Version/);
  assert.equal(existsSync(join(home, '.kimi-code')), false);
});

test('install and update register the managed package while preserving native data and other plugins', t => {
  const home = scratch(t), plugins = join(home, 'plugins');
  mkdirSync(plugins);
  const other = { id: 'another-plugin', root: '/another/local/plugin', source: 'local-path', enabled: false, custom: 'keep' };
  writeFileSync(join(plugins, 'installed.json'), JSON.stringify({ version: 1, plugins: [other], extra: 'keep' }));
  writeFileSync(join(home, 'config.toml'), 'default_model = "personal"\n');
  mkdirSync(join(home, 'evolver'));
  writeFileSync(join(home, 'evolver', 'kimi-distill-drafts.json'), '[{"title":"unpublished"}]');
  writeFileSync(join(home, 'evolver', 'kimi-settings.json'), '{"recall":false}');
  const installed = installKimi({ home, version: '1.2.3' });
  assert.equal(installed.installed, true);
  assert.equal(installed.version, '1.2.3');
  let registry = JSON.parse(readFileSync(join(plugins, 'installed.json'), 'utf8'));
  assert.deepEqual(registry.plugins[0], other);
  assert.equal(registry.extra, 'keep');
  assert.deepEqual(registry.plugins[1], {
    id: 'evolver-plugin', root: installed.path, source: 'local-path', enabled: true, installedAt: registry.plugins[1].installedAt,
  });
  assert.ok(Number.isFinite(Date.parse(registry.plugins[1].installedAt)));
  registry.plugins[1].enabled = false;
  writeFileSync(join(plugins, 'installed.json'), JSON.stringify(registry));
  const updated = installKimi({ operation: 'update', home, version: '2.0.0' });
  assert.equal(updated.version, '2.0.0');
  registry = JSON.parse(readFileSync(join(plugins, 'installed.json'), 'utf8'));
  assert.equal(registry.plugins.length, 2);
  assert.equal(registry.plugins[1].enabled, false, 'update retains a user-disabled plugin');
  assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), 'default_model = "personal"\n');
  assert.equal(readFileSync(join(home, 'evolver', 'kimi-distill-drafts.json'), 'utf8'), '[{"title":"unpublished"}]');
  assert.equal(readFileSync(join(home, 'evolver', 'kimi-settings.json'), 'utf8'), '{"recall":false}');
  const removed = installKimi({ operation: 'remove', home });
  assert.equal(removed.installed, false);
  assert.equal(removed.packageRetained, true);
  assert.deepEqual(JSON.parse(readFileSync(join(plugins, 'installed.json'), 'utf8')), { version: 1, plugins: [other], extra: 'keep' });
  assert.ok(existsSync(join(installed.path, 'kimi.plugin.json')), 'native removal retains managed bytes');
  assert.equal(readFileSync(join(home, 'evolver', 'kimi-distill-drafts.json'), 'utf8'), '[{"title":"unpublished"}]');
});

test('remove sees a registration committed before it acquires the installer lock', t => {
  const home = scratch(t);
  installKimi({ home, version: '1.2.3' });
  const plugins = join(home, 'plugins');
  const file = join(plugins, 'installed.json');
  const guard = join(plugins, '.evolver-plugin-install.lock');
  const installed = readFileSync(file, 'utf8');
  writeFileSync(file, '{"version":1,"plugins":[]}');
  const read = fs.readFileSync;
  let committed = false;
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    const snapshot = read(path, ...args);
    if (path !== file || committed) return snapshot;
    committed = true;
    writeFileSync(file, installed);
    return existsSync(guard) ? read(path, ...args) : snapshot;
  });
  const removed = installKimi({ home, operation: 'remove' });
  assert.ok(committed);
  assert.equal(removed.packageRetained, true);
  assert.deepEqual(JSON.parse(read(file, 'utf8')).plugins, []);
});

test('invalid or unreadable registration never becomes an empty registry', t => {
  const home = scratch(t), plugins = join(home, 'plugins'), file = join(plugins, 'installed.json');
  mkdirSync(plugins);
  for (const text of ['{', 'null', '[]', '{"version":2,"plugins":[]}', '{"version":1,"plugins":[{}]}', '{"version":1,"plugins":[{"id":"same","root":"/a"},{"id":"same","root":"/b"}]}']) {
    writeFileSync(file, text);
    for (const operation of ['install', 'status', 'remove']) assert.throws(() => installKimi({ operation, home }));
    assert.equal(readFileSync(file, 'utf8'), text);
  }
  const text = '{"version":1,"plugins":[]}'; writeFileSync(file, text);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    if (path === file) throw Object.assign(new Error('fixture read denied'), { code: 'EACCES' });
    return read(path, ...args);
  });
  assert.throws(() => installKimi({ home }), /read denied/);
  assert.equal(read(file, 'utf8'), text);
  assert.equal(existsSync(join(plugins, 'managed')), false);
});

test('unmanaged bytes, foreign registrations and missing updates fail without mutation', t => {
  const home = scratch(t), target = join(home, 'plugins', 'managed', 'evolver-plugin');
  assert.throws(() => installKimi({ operation: 'update', home }), /not installed/);
  assert.throws(() => installKimi({ home, version: '01.2.3' }), /Version/);
  assert.deepEqual(installKimi({ home, dryRun: true }), { operation: 'install', path: target, dryRun: true });
  assert.equal(existsSync(join(home, 'plugins')), false);
  mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'personal-file'), 'keep');
  assert.throws(() => installKimi({ home }), /unmanaged/);
  assert.equal(readFileSync(join(target, 'personal-file'), 'utf8'), 'keep');
  rmSync(target, { recursive: true });
  const registry = join(home, 'plugins', 'installed.json'), text = JSON.stringify({ version: 1, plugins: [{ id: 'evolver-plugin', root: join(home, 'foreign') }] });
  writeFileSync(registry, text);
  assert.throws(() => installKimi({ home }), /another path/);
  assert.throws(() => installKimi({ home, operation: 'remove' }), /another path/);
  assert.equal(readFileSync(registry, 'utf8'), text);
});

for (const failure of ['activation', 'registry']) test(`a ${failure} failure restores the package and leaves the registry intact`, t => {
  const home = scratch(t), installed = installKimi({ home, version: '1.2.3' });
  const registry = join(home, 'plugins', 'installed.json'), before = readFileSync(registry, 'utf8');
  writeFileSync(join(installed.path, 'keep-on-failure'), 'previous package');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if ((failure === 'activation' && String(from).endsWith(`${sep}package`) && to === installed.path)
      || (failure === 'registry' && to === registry)) throw new Error(`fixture ${failure} failure`);
    return rename(from, to);
  });
  assert.throws(() => installKimi({ home, operation: 'update', version: '2.0.0' }), new RegExp(`${failure} failure`));
  assert.equal(readFileSync(join(installed.path, 'keep-on-failure'), 'utf8'), 'previous package');
  assert.equal(readFileSync(registry, 'utf8'), before);
  assert.equal(readdirSync(home).some(name => name.startsWith('.evolver-install-')), false);
  assert.equal(readdirSync(join(home, 'plugins')).some(name => /\.tmp$|\.lock/.test(name)), false);
});

test('a failed rollback retains the old package for explicit recovery', t => {
  const home = scratch(t), installed = installKimi({ home, version: '1.2.3' });
  writeFileSync(join(installed.path, 'keep-on-failure'), 'previous package');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === installed.path) throw new Error('fixture activation/rollback failure');
    return rename(from, to);
  });
  assert.throws(() => installKimi({ home, operation: 'update', version: '2.0.0' }), /previous package is retained at/);
  const stages = readdirSync(home).filter(name => name.startsWith('.evolver-install-'));
  assert.equal(stages.length, 1);
  assert.equal(readFileSync(join(home, stages[0], 'previous', 'keep-on-failure'), 'utf8'), 'previous package');
  assert.equal(JSON.parse(readFileSync(join(home, 'plugins', 'installed.json'), 'utf8')).plugins[0].root, installed.path);
});

test('the next installer run restores a backup left by a failed rollback', t => {
  const home = scratch(t), installed = installKimi({ home, version: '1.2.3' });
  const registry = join(home, 'plugins', 'installed.json'), before = readFileSync(registry, 'utf8');
  writeFileSync(join(installed.path, 'keep-on-failure'), 'previous package');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === registry || (String(from).endsWith(`${sep}previous`) && to === installed.path)) throw new Error('fixture registry or rollback failure');
    return rename(from, to);
  });
  assert.throws(() => installKimi({ home, operation: 'update', version: '2.0.0' }), /previous package is retained at/);
  t.mock.restoreAll();
  assert.equal(existsSync(installed.path), false);
  const stage = readdirSync(home).find(name => name.startsWith('.evolver-install-'));
  assert.deepEqual(readdirSync(join(home, stage)), ['previous']);

  assert.equal(installKimi({ home, operation: 'status' }).version, '1.2.3');
  assert.equal(readFileSync(join(installed.path, 'keep-on-failure'), 'utf8'), 'previous package');
  assert.equal(readFileSync(registry, 'utf8'), before);
  assert.equal(existsSync(join(home, stage)), false);
});

test('a later installer run recovers an update interrupted after the backup rename', t => {
  const home = scratch(t), installed = installKimi({ home, version: '1.2.3' });
  const registry = join(home, 'plugins', 'installed.json');
  const oldRegistry = JSON.parse(readFileSync(registry, 'utf8'));
  oldRegistry.plugins[0].enabled = false;
  writeFileSync(registry, JSON.stringify(oldRegistry));
  writeFileSync(join(installed.path, 'keep-on-failure'), 'previous package');
  const module = new URL('../../../scripts/install-kimi.mjs', import.meta.url).href;
  const interrupt = `import fs from 'node:fs';
import { installKimi } from ${JSON.stringify(module)};
const [home, target] = process.argv.slice(1);
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  rename(from, to);
  if (from === target) process.exit(73);
};
installKimi({ home, operation: 'update', version: '2.0.0' });
`;
  const crashAfterBackup = () => {
    assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', interrupt, home, installed.path], {
      timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
    }), { status: 73 });
    assert.equal(existsSync(installed.path), false);
    assert.deepEqual(JSON.parse(readFileSync(registry, 'utf8')), oldRegistry);
  };
  crashAfterBackup();
  const stage = readdirSync(home).find(name => name.startsWith('.evolver-install-'));
  const duplicate = mkdtempSync(join(home, '.evolver-install-'));
  cpSync(join(home, stage), duplicate, { recursive: true });
  assert.throws(() => installKimi({ home, operation: 'status' }), /Multiple interrupted Kimi updates/);
  assert.equal(existsSync(installed.path), false);
  assert.equal(readFileSync(join(duplicate, 'previous', 'keep-on-failure'), 'utf8'), 'previous package');
  rmSync(duplicate, { recursive: true, force: true });

  assert.equal(installKimi({ home, operation: 'status' }).version, '1.2.3');
  assert.equal(readFileSync(join(installed.path, 'keep-on-failure'), 'utf8'), 'previous package');
  assert.deepEqual(JSON.parse(readFileSync(registry, 'utf8')), oldRegistry);
  assert.equal(readdirSync(home).some(name => name.startsWith('.evolver-install-')), false);

  crashAfterBackup();
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from).endsWith(`${sep}package`) && to === installed.path) throw new Error('fixture activation failure');
    return rename(from, to);
  });
  assert.throws(() => installKimi({ home, operation: 'update', version: '3.0.0' }), /fixture activation failure/);
  t.mock.restoreAll();
  assert.equal(readFileSync(join(installed.path, 'keep-on-failure'), 'utf8'), 'previous package');
  assert.equal(installKimi({ home, operation: 'update', version: '3.0.0' }).version, '3.0.0');
  assert.deepEqual(JSON.parse(readFileSync(registry, 'utf8')), oldRegistry);
  assert.equal(readdirSync(home).some(name => name.startsWith('.evolver-install-')), false);
});

test('a concurrent installer cannot replace a package while a failed registry write is rolling back', async t => {
  const home = scratch(t), installed = installKimi({ home, version: '1.2.3' });
  const registry = join(home, 'plugins', 'installed.json'), ready = join(home, 'rollback-ready'), release = join(home, 'allow-rollback');
  const module = new URL('../../../scripts/install-kimi.mjs', import.meta.url).href;
  writeFileSync(join(installed.path, 'keep-on-failure'), 'original package');
  const writer = join(home, 'writer.mjs');
  writeFileSync(writer, `import fs from 'node:fs';
import { installKimi } from ${JSON.stringify(module)};
const [home, target, registry, ready, release] = process.argv.slice(2);
const rename = fs.renameSync, remove = fs.rmSync;
fs.renameSync = (from, to) => { if (to === registry) throw new Error('fixture registry failure'); return rename(from, to); };
fs.rmSync = (file, options) => {
  if (file === target) {
    fs.writeFileSync(ready, 'ready');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(release)) {
      if (Date.now() >= deadline) throw new Error('fixture rollback barrier expired');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  return remove(file, options);
};
try { installKimi({ home, operation: 'update', version: '2.0.0' }); console.log(JSON.stringify({ unexpected: 'success' })); }
catch (error) { console.log(JSON.stringify({ error: error.message, code: error.code })); }
`);
  const launch = (args) => {
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr))); });
  };
  const first = launch([writer, home, installed.path, registry, ready, release]);
  const deadline = Date.now() + 10_000;
  while (!existsSync(ready)) {
    if (Date.now() >= deadline) throw new Error('fixture writer did not reach rollback');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const competing = join(home, 'competing.mjs');
  writeFileSync(competing, `import { installKimi } from ${JSON.stringify(module)};
try { console.log(JSON.stringify(installKimi({ home: process.argv[2], operation: 'update', version: '3.0.0' }))); }
catch (error) { console.log(JSON.stringify({ error: error.message, code: error.code })); }
`);
  let other;
  try { other = await launch([competing, home]); }
  finally { writeFileSync(release, 'release'); }
  const failed = await first;
  assert.equal(other.code, 'ELOCKED', 'activation stays excluded until the first installer finishes rollback');
  assert.match(failed.error, /fixture registry failure/);
  assert.equal(installKimi({ home, operation: 'status' }).version, '1.2.3');
  assert.equal(readFileSync(join(installed.path, 'keep-on-failure'), 'utf8'), 'original package');
  assert.equal(installKimi({ home, operation: 'update', version: '3.0.0' }).version, '3.0.0');
  assert.equal(readdirSync(home).some(name => name.startsWith('.evolver-install-')), false);
});

test('the released bundle keeps its bytes/version by default without allowing an implicit downgrade', t => {
  const root = scratch(t), checkout = join(root, 'checkout'), home = join(root, 'native');
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  for (const file of ['bin', 'lib', 'scripts', 'hosts/kimi', 'LICENSE', 'package.json', 'node_modules/smol-toml']) {
    mkdirSync(dirname(join(checkout, file)), { recursive: true });
    cpSync(join(repository, file), join(checkout, file), { recursive: true });
  }
  const bundle = join(checkout, 'dist', 'kimi');
  pack('kimi', bundle, { version: '9.8.7' });
  writeFileSync(join(bundle, 'README.md'), 'The released guide, not the source checkout.\n');
  const run = (operation, ...args) => JSON.parse(execFileSync(process.execPath, [join(checkout, 'scripts', 'install-kimi.mjs'), operation, '--home', home, ...args], { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const installed = run('install');
  assert.equal(run('status').version, '9.8.7');
  assert.equal(readFileSync(join(installed.path, 'README.md'), 'utf8'), 'The released guide, not the source checkout.\n');
  assert.equal(run('update').version, '9.8.7', 'the same version can be reinstalled');
  run('update', '--version', '10.0.0');
  assert.equal(run('status').version, '10.0.0');
  assert.equal(readFileSync(join(installed.path, 'README.md'), 'utf8'), readFileSync(join(checkout, 'hosts', 'kimi', 'dist', 'README.md'), 'utf8'));
  const registryFile = join(home, 'plugins', 'installed.json'), before = readFileSync(registryFile, 'utf8');
  const installedGuide = readFileSync(join(installed.path, 'README.md'), 'utf8');
  assert.throws(() => run('update'), /Refusing to downgrade Kimi plugin from 10\.0\.0 to 9\.8\.7/);
  assert.throws(() => run('install'), /Refusing to downgrade Kimi plugin from 10\.0\.0 to 9\.8\.7/);
  assert.equal(run('status').version, '10.0.0');
  assert.equal(readFileSync(join(installed.path, 'README.md'), 'utf8'), installedGuide);
  assert.equal(readFileSync(registryFile, 'utf8'), before);
  const manifestFile = join(bundle, 'kimi.plugin.json'), released = JSON.parse(readFileSync(manifestFile, 'utf8'));
  for (const invalid of [{ name: 'foreign' }, { version: 'not-a-version' }]) {
    writeFileSync(manifestFile, JSON.stringify({ ...released, ...invalid }));
    assert.throws(() => run('update'), /Invalid Kimi package/);
    assert.equal(run('status').version, '10.0.0');
  }
  const setBundleVersion = version => writeFileSync(manifestFile, JSON.stringify({ ...released, version }));
  setBundleVersion('10.0.0-rc.10');
  assert.throws(() => run('update'), /Refusing to downgrade Kimi plugin from 10\.0\.0 to 10\.0\.0-rc\.10/);
  assert.equal(run('update', '--version', '10.0.0-rc.2').version, '10.0.0-rc.2', 'an explicit version can downgrade');
  assert.equal(run('update').version, '10.0.0-rc.10', 'numeric prerelease identifiers compare numerically');
  setBundleVersion('10.0.0-rc.2');
  assert.throws(() => run('update'), /Refusing to downgrade Kimi plugin from 10\.0\.0-rc\.10 to 10\.0\.0-rc\.2/);
  fs.renameSync(bundle, join(checkout, 'old-bundle'));
  assert.throws(() => run('update'), /Refusing to downgrade Kimi plugin from 10\.0\.0-rc\.10 to 1\.0\.0/);
  assert.equal(run('status').version, '10.0.0-rc.10');
  assert.equal(readdirSync(home).some(name => name.startsWith('.evolver-install-')), false);
});

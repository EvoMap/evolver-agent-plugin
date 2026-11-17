import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { prepareEngine } from '../../lib/engine/setup.js';
import { evolverCliOf } from '../../lib/runtime/cli-executor.js';
import { desktopEngineOf } from '../../lib/runtime/engine/desktop.js';

const version = '2.0.50';
const schema = 'evolver.desktop.plugin-engine.v1';
const binaryName = process.platform === 'win32' ? 'evolver-windows-x64.exe' : `evolver-${process.platform}-${process.arch}`;

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'evolver desktop engine '));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, '.evomap-desktop', 'tools', 'evolver');
  const write = (file, contents) => {
    const entry = join(root, file);
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, typeof contents === 'string' ? contents : JSON.stringify(contents));
    return entry;
  };
  return { home, root, write, select: (selection) => write('plugin-engine.json', { version, schema, ...selection }) };
}

test('Desktop native selection verifies digest and follows only the active installation', async (t) => {
  const { home, write, select } = fixture(t);
  assert.equal(desktopEngineOf(home), null);
  const payload = 'verified Desktop release';
  const digest = createHash('sha256').update(payload).digest('hex');
  const artifactRows = ['evolver-darwin-arm64', 'evolver-darwin-x64', 'evolver-linux-arm64', 'evolver-linux-x64', 'evolver-windows-x64.exe']
    .map((path) => ({ path, sha256: digest }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signature = sign(null, Buffer.from(JSON.stringify({ version, artifacts: artifactRows })), privateKey).toString('base64');
  const manifest = {
    schemaVersion: 1,
    version,
    signatureAlg: 'ed25519',
    signature,
    artifacts: artifactRows.map((asset) => ({
      ...asset,
      size: payload.length,
      downloadUrl: `https://github.com/EvoMap/evolver/releases/download/v${version}/${asset.path}`,
    })).reverse(),
  };
  const resolve = () => desktopEngineOf(home, publicKey);
  const record = { schema: 'evolver.native.install.v1', version, binary: binaryName, manifest };
  const entry = write(join('native', version, digest, binaryName), payload);
  write('native-install.json', { ...record, digest });
  select({ kind: 'native', digest });
  assert.throws(() => desktopEngineOf(home), /could not be verified/, 'the official key does not accept the fixture key');
  const engine = resolve();
  assert.deepEqual(engine.args, []);
  assert.equal(engine.command, entry);
  assert.equal(engine.version, version);
  await engine.verify();
  write('native-install.json', { ...record, digest, manifest: { ...manifest, signature: Buffer.alloc(64).toString('base64') } });
  assert.throws(resolve, /could not be verified/, 'a forged signature cannot vouch for the selected digest');
  write('native-install.json', { ...record, digest });
  writeFileSync(entry, 'altered Desktop release');
  await assert.rejects(engine.verify(), /could not be verified/);
  write('npm-install.json', { schema: 'evolver.npm.install.v1', prefix: 'npm-42' });
  assert.throws(resolve, /could not be verified/);

  rmSync(join(home, '.evomap-desktop', 'tools', 'evolver', 'npm-install.json'));
  const legacy = write(join('native', version, binaryName), payload);
  write('native-install.json', record);
  assert.throws(resolve, /could not be verified/);
  select({ kind: 'native', digest, legacy: true });
  assert.equal(resolve().command, legacy);
  await resolve().verify();
});

test('Desktop npm uses its selected package directly through Node and blocks traversal or stale selection', async (t) => {
  const { home, write, select } = fixture(t);
  const prefix = 'npm-42';
  const directory = join(prefix, 'node_modules', '@evomap', 'evolver');
  const manifest = { name: '@evomap/evolver', version, bin: { evolver: 'cli.cjs' } };
  const entry = write(join(directory, 'cli.cjs'), 'console.log(process.argv.slice(2).join(" "));');
  write(join(directory, 'package.json'), manifest);
  write('npm-install.json', { schema: 'evolver.npm.install.v1', prefix });
  select({ kind: 'npm', prefix });
  assert.deepEqual(desktopEngineOf(home).args, [entry]);
  const cli = evolverCliOf({
    desktopEngine: () => desktopEngineOf(home),
    enginePrefix: 'unused',
    managedEngine: () => assert.fail('used the plugin engine despite a Desktop selection'),
  });
  assert.deepEqual(await cli.run(['--version', 'a preserved argument']), { ok: true, text: '--version a preserved argument' });

  const record = join(directory, 'package.json');
  write(record, { ...manifest, bin: { evolver: '../outside.cjs' } });
  write(join(directory, '..', 'outside.cjs'), 'throw new Error("outside Desktop package");');
  assert.match((await cli.run(['--version'])).text, /could not be verified/);
  write(record, manifest);
  select({ kind: 'npm', prefix: 'npm-43' });
  assert.match((await cli.run(['--version'])).text, /could not be verified/);
});

test('Desktop selection rejects a symlink or junction before resolving a package', (t) => {
  const { home, root, write, select } = fixture(t);
  const prefix = 'npm-42';
  write('npm-install.json', { schema: 'evolver.npm.install.v1', prefix });
  select({ kind: 'npm', prefix });
  const target = join(home, 'other-package');
  mkdirSync(join(target, 'node_modules', '@evomap', 'evolver'), { recursive: true });
  writeFileSync(join(target, 'node_modules', '@evomap', 'evolver', 'package.json'), JSON.stringify({ name: '@evomap/evolver', version, bin: { evolver: 'cli.cjs' } }));
  writeFileSync(join(target, 'node_modules', '@evomap', 'evolver', 'cli.cjs'), 'throw new Error("untrusted package");');
  symlinkSync(target, join(root, prefix), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => desktopEngineOf(home), /could not be verified/);
});

test('Desktop accepts a Windows short name for a real profile directory', { skip: process.platform !== 'win32' }, (t) => {
  const { home, write, select } = fixture(t);
  const cmd = join(process.env.SystemRoot, 'System32', 'cmd.exe');
  const shortHome = execFileSync(cmd, ['/d', '/u', '/c', 'for %i in ("%EVOLVER_TEST_HOME%") do @echo %~si'], {
    env: { ...process.env, EVOLVER_TEST_HOME: home }, encoding: 'utf16le', windowsHide: true, windowsVerbatimArguments: true,
  }).trim();
  if (shortHome.toLowerCase() === home.toLowerCase()) {
    t.skip('the test volume does not assign short names');
    return;
  }
  assert.equal(realpathSync.native(shortHome), realpathSync.native(home));
  write('node_modules/@evomap/evolver/package.json', { name: '@evomap/evolver', version, bin: { evolver: 'cli.cjs' } });
  write('node_modules/@evomap/evolver/cli.cjs', 'console.log(42);');
  select({ kind: 'npm', prefix: '.' });
  assert.equal(desktopEngineOf(shortHome).version, version);
});

test('engine setup launches Desktop directly, never installs npm, and preserves a different running Proxy', async () => {
  const calls = [];
  const desktop = { version, verify: async () => calls.push('verified') };
  const runtime = {
    nodeVersion: '24.0.0',
    now: () => 5,
    desktopEngine: () => desktop,
    managedEngine: () => assert.fail('looked up plugin engine'),
    pathEngine: () => assert.fail('looked up PATH engine'),
    installLatest: () => assert.fail('installed a second engine'),
    runningProxy: async () => null,
    runDesktop: async (selected, args) => {
      assert.equal(selected, desktop);
      calls.push(...args);
      return { ok: true };
    },
    waitForProxy: async (matches) => {
      assert.ok(matches({ version, desktopProof: 'verified' }));
      assert.equal(matches({ version, desktopProof: null }), false);
      return { version, desktopProof: 'verified' };
    },
  };
  const outcome = await prepareEngine(runtime);
  assert.equal(outcome.status, 'started');
  assert.equal(outcome.source, 'desktop');
  assert.equal(outcome.proxyVersion, version);
  assert.equal(outcome.desktopProof, 'verified');
  assert.deepEqual(calls, ['verified', 'lifecycle', 'start']);
  const mismatch = await prepareEngine({
    ...runtime,
    runningProxy: async () => ({ version, desktopProof: null }),
    runDesktop: () => assert.fail('touched the running Proxy'),
  });
  assert.equal(mismatch.status, 'start_failed');
  assert.match(mismatch.error, /different Evolver Proxy is running/);
  const existing = await prepareEngine({
    ...runtime,
    runningProxy: async () => ({ version, desktopProof: 'verified' }),
    runDesktop: () => assert.fail('relaunched the already running Desktop Proxy'),
  });
  assert.equal(existing.status, 'ready');
});

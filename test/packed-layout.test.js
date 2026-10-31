import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { pack, packedHosts, packSpecOf } from '../scripts/pack.mjs';

// What `evolver plugin install` checks in a packed folder (evolver-cli pluginBundle.ts and pluginInspection.ts):
// the folder names its host in .evolver-packed, its manifest names this plugin, its version and this repository,
// and its entry files sit where the host and the installer look for them.
const CONTRACT = {
  'claude-code': { manifest: '.claude-plugin/plugin.json', name: 'evolver-plugin', entries: ['hooks/hooks.json', 'hooks/register.ts', 'bin/relay.mjs'] },
  codex: { manifest: '.codex-plugin/plugin.json', name: 'evolver-plugin', entries: ['hooks/hooks.json', 'bin/hook.mjs'] },
  grok: { manifest: '.grok-plugin/plugin.json', name: 'evolver-plugin', entries: ['hooks/hooks.json', 'bin/hook.mjs'] },
  qoder: { manifest: '.qoder-plugin/plugin.json', name: 'evolver-plugin', entries: ['hooks/hooks.json', 'bin/hook.mjs'] },
  antigravity: { manifest: 'plugin.json', name: 'evolver-plugin', entries: ['hooks.json', 'bin/hook.mjs'] },
  opencode: { manifest: 'package.json', name: '@evomap/evolver-opencode', entries: ['server.mjs', 'tui.mjs'], npm: true },
  dsh: { manifest: 'package.json', name: '@evomap/dsh-evolver', entries: ['plugin.mjs'], npm: true },
};
const REPOSITORY = /^(?:git\+)?https:\/\/github\.com\/EvoMap\/evolver-agent-plugin(?:\.git)?$/i;

const repositoryOf = (manifest) => (typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url);
const isShipped = (files, path) => files.some((entry) => path === entry || path.startsWith(entry.endsWith('/') ? entry : `${entry}/`));

test('every packed host is in the installer contract, and every host in it is packed', () => {
  assert.deepEqual(packedHosts().filter((host) => host !== 'workbuddy').sort(), Object.keys(CONTRACT).sort());
});

for (const [host, contract] of Object.entries(CONTRACT)) {
  test(`${host}: the packed folder passes the checks evolver plugin install makes`, (t) => {
    const out = mkdtempSync(join(tmpdir(), `evolver-layout-${host}-`));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    const folder = join(out, host);
    pack(host, folder, { version: '9.8.7' });
    assert.equal(readFileSync(join(folder, '.evolver-packed'), 'utf8').trim(), host);
    const manifest = JSON.parse(readFileSync(join(folder, contract.manifest), 'utf8'));
    assert.equal(manifest.name, contract.name);
    assert.equal(manifest.version, '9.8.7');
    assert.match(repositoryOf(manifest) ?? '', REPOSITORY);
    for (const entry of contract.entries) assert.ok(existsSync(join(folder, entry)), `${entry} at the folder root`);
    if (!contract.npm) return;
    for (const path of [...contract.entries, '.evolver-packed']) assert.ok(isShipped(manifest.files, path), `${path} is in files, so a package manager installs it`);
    assert.ok(Object.values(manifest.exports ?? {}).every((target) => !target.startsWith('./hosts/')), 'exports name the root entries');
    assert.ok(Object.keys(packSpecOf(host).root).some((target) => target === contract.entries[0]));
  });
}

import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import profile from '../../../hosts/minimax/profile.js';
import { pack } from '../../../scripts/pack.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const checkoutManifest = () => JSON.parse(readFileSync(join(root, '.minimax-plugin/plugin.json'), 'utf8'));

test('the checkout manifest resolves its icon and native hooks from the repository root', () => {
  const manifest = checkoutManifest();
  assert.ok(existsSync(join(root, manifest.icon)));
  assert.deepEqual(manifest.hooks, ['hosts/minimax/dist/hooks/hooks.json']);
  const { hooks } = JSON.parse(readFileSync(join(root, manifest.hooks[0]), 'utf8'));
  assert.deepEqual(Object.keys(hooks), Object.keys(profile.events));
  assert.ok(existsSync(join(root, 'bin/hook.mjs')));
});

test('the native packed manifest loads only this host and shell hooks fit MiniMax’s actual ten-second limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-minimax-pack-'));
  try {
    pack('minimax', dir, { version: '1.2.3' });
    const manifest = JSON.parse(readFileSync(join(dir, '.minimax-plugin/plugin.json'), 'utf8'));
    assert.equal(manifest.name, 'evolver-plugin');
    assert.equal(manifest.version, '1.2.3');
    assert.deepEqual(manifest.hooks, ['hooks/hooks.json']);
    assert.deepEqual(manifest, { ...checkoutManifest(), version: '1.2.3', hooks: ['hooks/hooks.json'] });
    assert.ok(existsSync(join(dir, manifest.icon)));
    const { hooks } = JSON.parse(readFileSync(join(dir, manifest.hooks[0]), 'utf8'));
    assert.deepEqual(Object.keys(hooks), Object.keys(profile.events));
    for (const [event, entries] of Object.entries(hooks)) {
      const [handler] = entries[0].hooks;
      assert.equal(handler.args, undefined, 'native MINIMAX rejects exec-form args');
      assert.equal(handler.timeout, 10);
      assert.ok(handler.command.endsWith(`minimax ${event}`));
      assert.ok(handler.commandWindows.endsWith(`minimax ${event}`));
    }
    assert.equal(hooks.UserPromptSubmit[0].hooks[0].timeout * 1000, profile.budgets.prompt);
    for (const file of ['bin/hook.mjs', 'bin/worker.mjs', 'bin/command.mjs', 'hosts/minimax/profile.js', 'lib/runtime/process/windows.js']) assert.ok(existsSync(join(dir, file)), file);
    for (const file of ['.claude-plugin', '.mcp.json', 'hosts/workbuddy', 'skills', 'node_modules', 'test', 'acceptance', '.git', 'config.yaml']) assert.equal(existsSync(join(dir, file)), false, file);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')), { private: true, type: 'module' });
    const inspect = folder => {
      for (const name of readdirSync(folder)) {
        const file = join(folder, name), stat = lstatSync(file);
        assert.equal(stat.isSymbolicLink(), false, file);
        if (stat.isDirectory()) inspect(file);
        else if (/\.(?:m?js|json|md)$/.test(name)) assert.equal(readFileSync(file, 'utf8').includes(root), false, `${file} embeds its build machine path`);
      }
    };
    inspect(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { PATCH_TOOL, SHELL_TOOL } from '../../../hosts/codex/evidence.js';
import codex from '../../../hosts/codex/profile.js';
import { pack, packedHosts, packSpecOf } from '../../../scripts/pack.mjs';

const at = (path) => new URL(`../../../${path}`, import.meta.url);
const json = (path) => JSON.parse(readFileSync(at(path), 'utf8'));
const DIST = 'hosts/codex/dist';
const { hooks } = json(`${DIST}/hooks/hooks.json`);
const handlerOf = (event) => hooks[event][0].hooks[0];
// Codex runs SessionEnd and Interrupt hooks for three seconds at most.
const SHORT_HOOKS = ['Interrupt', 'SessionEnd'];

let packed = null;
after(() => packed && rmSync(packed, { recursive: true, force: true }));
function packedPlugin() {
  if (!packed) {
    packed = mkdtempSync(join(tmpdir(), 'evolver-codex-packed-'));
    pack('codex', packed);
  }
  return packed;
}

test('the hook registration covers exactly the profile\'s events, each running bin/hook.mjs for this agent', () => {
  assert.deepEqual(Object.keys(hooks), Object.keys(codex.events));
  for (const [event, [entry, ...rest]] of Object.entries(hooks)) {
    assert.deepEqual(rest, [], event);
    assert.equal(entry.hooks.length, 1, event);
    assert.equal(handlerOf(event).type, 'command');
    assert.equal(handlerOf(event).command, `node "\${PLUGIN_ROOT}/bin/hook.mjs" codex ${event}`);
    assert.equal(handlerOf(event).command_windows, `node "%PLUGIN_ROOT%\\bin\\hook.mjs" codex ${event}`);
    assert.ok(handlerOf(event).timeout > 0, event);
  }
  for (const event of SHORT_HOOKS) assert.ok(handlerOf(event).timeout <= 3, event);
  assert.equal(handlerOf('UserPromptSubmit').timeout * 1000, codex.budgets.prompt, 'the recall and command budget is the hook timeout');
});

test('the tool hooks fire for Bash and apply_patch only, and a compaction starts no session', () => {
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const matcher = new RegExp(hooks[event][0].matcher);
    assert.ok([SHELL_TOOL, PATCH_TOOL].every((tool) => matcher.test(tool)), event);
    assert.equal(matcher.test('write_stdin'), false, event);
  }
  const sources = new RegExp(hooks.SessionStart[0].matcher);
  assert.deepEqual(['startup', 'resume', 'clear', 'fork', 'compact'].map((source) => sources.test(source)), [true, true, true, true, false]);
});

test('the marketplace Codex reads at the repository root installs dist/codex, where npm run pack puts it', () => {
  const marketplace = json('.agents/plugins/marketplace.json');
  const manifest = json(`${DIST}/.codex-plugin/plugin.json`);
  const [entry, ...rest] = marketplace.plugins;
  assert.deepEqual(rest, []);
  assert.deepEqual(entry.source, { source: 'local', path: './dist/codex' });
  assert.equal(json('package.json').scripts.pack, 'node scripts/pack.mjs all dist');
  assert.ok(packedHosts().includes('codex'));
  assert.equal(entry.name, manifest.name);
  assert.deepEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  assert.equal(`${entry.name}@${marketplace.name}`, 'evolver-plugin@evomap', 'its name on every host, in the marketplace the standalone plugin used');
});

test('the README installs evolver-plugin@evomap, after removing the standalone evolver@evomap, and names the new trust keys', () => {
  const readme = readFileSync(at(`${DIST}/README.md`), 'utf8');
  const removal = readme.indexOf('codex plugin remove evolver@evomap');
  assert.ok(removal >= 0);
  assert.ok(removal < readme.indexOf('codex plugin marketplace add EvoMap/evolver-agent-plugin --ref release'), 'the standalone plugin goes first');
  assert.match(readme, /^codex plugin add evolver-plugin@evomap$/m);
  assert.match(readme, /hooks\.state\."evolver-plugin@evomap:hooks\/hooks\.json:user_prompt_submit:0:0"/);
  assert.match(readme, /plugins\/cache\/evomap\/evolver-plugin\/<version>\/bin\/command\.mjs codex evolver-status/);
});

test('the manifest and the hook registration sit at the packed folder\'s root, where Codex looks for them', () => {
  const root = packSpecOf('codex').root;
  assert.equal(root['.codex-plugin/plugin.json'], `${DIST}/.codex-plugin/plugin.json`);
  assert.equal(root['hooks/hooks.json'], `${DIST}/hooks/hooks.json`);
  const folder = packedPlugin();
  const manifest = JSON.parse(readFileSync(join(folder, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.repository, 'https://github.com/EvoMap/evolver-agent-plugin');
  for (const asset of [manifest.interface.logo, manifest.interface.composerIcon]) assert.ok(existsSync(join(folder, asset)), asset);
  for (const file of ['hooks/hooks.json', 'bin/hook.mjs', 'bin/worker.mjs', 'bin/command.mjs', 'hosts/codex/profile.js', 'README.md', 'LICENSE']) assert.ok(existsSync(join(folder, file)), file);
  assert.equal(JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')).type, 'module');
});

test('the packed folder holds nothing else Codex would load: no skill, MCP server, app or other host', () => {
  const folder = packedPlugin();
  for (const path of ['skills', '.mcp.json', '.app.json', 'commands', '.claude-plugin', 'hosts/cursor', 'hosts/workbuddy']) assert.equal(existsSync(join(folder, path)), false, path);
});

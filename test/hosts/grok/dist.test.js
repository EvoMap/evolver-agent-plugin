import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { EDIT_TOOLS, SHELL_TOOLS } from '../../../hosts/grok/evidence.js';
import grok from '../../../hosts/grok/profile.js';
import { EVOLVE_PROMPT } from '../../../lib/app/commands/evolve.js';
import { pack, packedHosts, packSpecOf } from '../../../scripts/pack.mjs';

const at = (path) => new URL(`../../../${path}`, import.meta.url);
const json = (path) => JSON.parse(readFileSync(at(path), 'utf8'));
const DIST = 'hosts/grok/dist';
const { hooks } = json(`${DIST}/hooks/hooks.json`);
const handlerOf = (event) => hooks[event][0].hooks[0];
// grok gives a plugin's SessionEnd hook 1.5 s whatever its timeout says.
const SESSION_END_SECONDS = 2;

let packed = null;
after(() => packed && rmSync(packed, { recursive: true, force: true }));
function packedPlugin() {
  if (!packed) {
    packed = mkdtempSync(join(tmpdir(), 'evolver-grok-packed-'));
    pack('grok', packed);
  }
  return packed;
}

test('the hook registration covers exactly the profile\'s events, each running bin/hook.mjs from GROK_PLUGIN_ROOT', () => {
  assert.deepEqual(Object.keys(hooks), Object.keys(grok.events));
  for (const [event, [entry, ...rest]] of Object.entries(hooks)) {
    assert.deepEqual(rest, [], event);
    assert.equal(entry.hooks.length, 1, event);
    assert.equal(handlerOf(event).type, 'command');
    assert.equal(handlerOf(event).command, `node "\${GROK_PLUGIN_ROOT}/bin/hook.mjs" grok ${event}`);
    assert.ok(handlerOf(event).timeout > 0, event);
  }
  assert.equal(handlerOf('UserPromptSubmit').timeout * 1000, grok.budgets.prompt, 'the recall and command budget is the hook timeout');
  assert.ok(handlerOf('SessionEnd').timeout <= SESSION_END_SECONDS);
});

test('PreToolUse fires for the edit tools only; every tool result reaches PostToolUse, so the first one carries the strategy', () => {
  const matcher = new RegExp(hooks.PreToolUse[0].matcher);
  assert.ok(EDIT_TOOLS.every((tool) => matcher.test(tool)));
  assert.ok([...SHELL_TOOLS, 'read_file', 'grep'].every((tool) => !matcher.test(tool)));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'StopCancelled', 'SessionEnd']) {
    assert.equal(hooks[event][0].matcher, undefined, event);
  }
});

test('the marketplace grok reads at the repository root installs dist/grok from the release tag', () => {
  const marketplace = json('.grok-plugin/marketplace.json');
  const manifest = json(`${DIST}/.grok-plugin/plugin.json`);
  const [entry, ...rest] = marketplace.plugins;
  assert.deepEqual(rest, []);
  assert.deepEqual(entry.source, { source: 'git-subdir', url: 'https://github.com/EvoMap/evolver-agent-plugin.git', path: 'dist/grok', ref: `v${manifest.version}` });
  assert.ok(packedHosts().includes('grok'));
  assert.equal(entry.name, manifest.name);
  assert.equal(entry.name, 'evolver-plugin');
  assert.equal(entry.version, manifest.version);
  assert.equal(marketplace.name, 'evomap');
});

test('the manifest names the plugin as every host does, at the version of the latest hosts, MIT, by EvoMap', () => {
  const manifest = json(`${DIST}/.grok-plugin/plugin.json`);
  assert.equal(manifest.name, 'evolver-plugin');
  assert.equal(manifest.version, json('hosts/codex/dist/.codex-plugin/plugin.json').version);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.author.name, 'EvoMap');
  assert.equal(manifest.repository, 'https://github.com/EvoMap/evolver-agent-plugin');
});

test('the one command file is the evolution checkpoint for the agent, word for word, and the model may not invoke it', () => {
  const source = readFileSync(at(`${DIST}/commands/evolver-evolve.md`), 'utf8');
  assert.ok(source.includes(EVOLVE_PROMPT));
  assert.doesNotMatch(EVOLVE_PROMPT, /behind the prompt/, 'on Grok the strategy joins the turn at a tool result');
  assert.match(source, /^disable-model-invocation: true$/m);
  assert.match(source, /\$ARGUMENTS/);
  assert.deepEqual(Object.keys(packSpecOf('grok').root).filter((path) => path.startsWith('commands/')), ['commands/evolver-evolve.md']);
});

test('the packed folder holds the manifest, hooks and entries at its root, and nothing else grok would load', () => {
  const folder = packedPlugin();
  for (const file of ['.grok-plugin/plugin.json', 'hooks/hooks.json', 'commands/evolver-evolve.md', 'bin/hook.mjs', 'bin/worker.mjs', 'bin/command.mjs', 'hosts/grok/profile.js', 'README.md', 'LICENSE']) {
    assert.ok(existsSync(join(folder, file)), file);
  }
  assert.equal(JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')).type, 'module');
  for (const path of ['skills', 'agents', '.mcp.json', '.lsp.json', '.claude-plugin', 'hosts/codex', 'hosts/claude-code']) assert.equal(existsSync(join(folder, path)), false, path);
});

test('the README installs from the marketplace and names the commands as they are typed', () => {
  const readme = readFileSync(at(`${DIST}/README.md`), 'utf8');
  assert.match(readme, /^grok plugin marketplace add EvoMap\/evolver-agent-plugin$/m);
  assert.match(readme, /^grok plugin install evolver-plugin --trust$/m);
  assert.match(readme, /installed-plugins\/<folder>\/dist\/grok\/bin\/command\.mjs grok evolver-status/, 'the marketplace installs the release tag whole');
  assert.match(readme, /`grok inspect` lists it as enabled/);
  assert.doesNotMatch(readme, /`grok plugin list` shows it enabled/, 'grok plugin list shows no status');
  assert.match(readme, /`grok plugin install EvoMap\/evolver-agent-plugin`, a form Grok also\naccepts, installs the repository's root instead/);
  assert.match(readme, /stays at the front of\nGrok's queue/);
});

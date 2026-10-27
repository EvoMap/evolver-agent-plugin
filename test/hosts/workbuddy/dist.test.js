import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import profile from '../../../hosts/workbuddy/profile.js';
import { COMMANDS } from '../../../lib/app/commands/index.js';

const at = (path) => new URL(`../../../${path}`, import.meta.url);
const json = (path) => JSON.parse(readFileSync(at(path), 'utf8'));
const DIST = 'hosts/workbuddy/dist';
const HOOK_EVENTS = Object.keys(profile.events);

function frontMatterOf(text) {
  const [, block] = /^---\n([\s\S]*?)\n---\n/.exec(text);
  return Object.fromEntries(block.split('\n').map((entry) => /^([\w-]+): (.*)$/.exec(entry)).map(([, key, value]) => [key, JSON.parse(value)]));
}

test('each hook WorkBuddy registers runs bin/hook.mjs for this agent, within the timeout the profile budgets for', () => {
  const { hooks } = json(`${DIST}/hooks/hooks.json`);
  assert.deepEqual(Object.keys(hooks), HOOK_EVENTS);
  for (const [event, [entry]] of Object.entries(hooks)) {
    assert.equal(entry.hooks.length, 1);
    assert.equal(entry.hooks[0].type, 'command');
    assert.equal(entry.hooks[0].command, `node "\${CODEBUDDY_PLUGIN_ROOT}/bin/hook.mjs" workbuddy ${event}`);
  }
  assert.equal(hooks.UserPromptSubmit[0].hooks[0].timeout * 1000, profile.budgets.prompt);
  assert.equal(hooks.PreToolUse[0].matcher, '^(Write|Edit|MultiEdit|NotebookEdit)$');
});

test('every plugin command ships as an inline script with the description and hint the plugin gives it', () => {
  const files = readdirSync(at(`${DIST}/commands`)).sort();
  assert.deepEqual(files, COMMANDS.map((command) => `${command.name}.md`).sort());
  for (const command of COMMANDS) {
    const text = readFileSync(at(`${DIST}/commands/${command.name}.md`), 'utf8');
    assert.deepEqual(frontMatterOf(text), { description: command.description, ...(command.hint && { 'argument-hint': command.hint }) });
    const [, script] = /!`([^`]+)`/.exec(text);
    assert.equal(script, `CODEBUDDY_PLUGIN_DATA="\${CODEBUDDY_PLUGIN_DATA}" exec node "\${CODEBUDDY_PLUGIN_ROOT}/bin/command.mjs" workbuddy ${command.name} <<'EVOLVER_ARGUMENTS'\n$ARGUMENTS\nEVOLVER_ARGUMENTS`);
  }
});

test('the marketplace at the repository root installs the packed plugin, dist/workbuddy, from the release branch CI publishes', () => {
  const marketplace = json('.codebuddy-plugin/marketplace.json');
  const manifest = json(`${DIST}/.codebuddy-plugin/plugin.json`);
  const [entry] = marketplace.plugins;
  const published = /publish-release-branch\.sh (\S+)/.exec(readFileSync(at('.github/workflows/release.yml'), 'utf8'))[1];
  assert.equal(marketplace.plugins.length, 1);
  assert.deepEqual(entry.source, { source: 'git-subdir', url: 'https://github.com/EvoMap/evolver-agent-plugin.git', path: 'dist/workbuddy', ref: published });
  assert.equal(entry.name, manifest.name);
  assert.equal(entry.version, manifest.version);
  assert.equal(marketplace.metadata.version, manifest.version);
  assert.equal(manifest.hooks, './hooks/hooks.json');
  assert.equal(manifest.commands, './commands');
  assert.equal(json(`${DIST}/package.json`).type, 'module');
});

test('the packed folder is a marketplace of its own, for trying a local build: the same entry, installed from itself', () => {
  const { plugins: [rootEntry], ...root } = json('.codebuddy-plugin/marketplace.json');
  const { plugins: [packedEntry], ...packed } = json(`${DIST}/.codebuddy-plugin/marketplace.json`);
  assert.deepEqual(packed, root);
  assert.deepEqual({ ...packedEntry, source: rootEntry.source }, rootEntry);
  assert.equal(packedEntry.source, './');
  assert.equal(json(`${DIST}/pack.json`).root['.codebuddy-plugin/marketplace.json'], `${DIST}/.codebuddy-plugin/marketplace.json`);
});

test('the plugin is evolver-plugin in the marketplace the standalone one came from, and adopts that one\'s data folder', () => {
  const marketplace = json('.codebuddy-plugin/marketplace.json');
  assert.equal(`${marketplace.plugins[0].name}@${marketplace.name}`, 'evolver-plugin@evomap-workbuddy');
  assert.deepEqual(profile.legacy[0], { folder: 'evolver-evomap-workbuddy' });
});

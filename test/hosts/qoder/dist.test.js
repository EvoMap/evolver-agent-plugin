// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { EDIT_TOOLS, SHELL_TOOLS } from '../../../hosts/qoder/evidence.js';
import qoder from '../../../hosts/qoder/profile.js';
import { COMMANDS } from '../../../lib/app/commands/index.js';
import { pack, packedHosts, packSpecOf } from '../../../scripts/pack.mjs';

const at = (path) => new URL(`../../../${path}`, import.meta.url);
const json = (path) => JSON.parse(readFileSync(at(path), 'utf8'));
const DIST = 'hosts/qoder/dist';
const { hooks } = json(`${DIST}/hooks/hooks.json`);
const handlerOf = (event) => hooks[event][0].hooks[0];
// The events Qoder CLI 1.1.79 documents; it reports a hook config error for one it does not know, such as Interrupt.
const QODER_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Notification', 'ConfigChange', 'InstructionsLoaded', 'CwdChanged',
  'FileChanged', 'WorktreeCreate', 'WorktreeRemove', 'Elicitation', 'ElicitationResult', 'TaskCreated', 'TaskCompleted',
  'PermissionRequest', 'PermissionDenied', 'TeammateIdle', 'Setup',
  // Undocumented, but sent once for every turn of the main agent, and the only hook an interrupted turn runs.
  'QueryEnd',
]);

let packed = null;
after(() => packed && rmSync(packed, { recursive: true, force: true }));
function packedPlugin() {
  if (!packed) {
    packed = mkdtempSync(join(tmpdir(), 'evolver-qoder-packed-'));
    pack('qoder', packed);
  }
  return packed;
}

test('the hook registration covers exactly the profile\'s events, each running bin/hook.mjs for this agent without a shell', () => {
  assert.deepEqual(Object.keys(hooks), Object.keys(qoder.events));
  for (const [event, [entry, ...rest]] of Object.entries(hooks)) {
    assert.ok(QODER_EVENTS.has(event), event);
    assert.deepEqual(rest, []);
    assert.equal(entry.hooks.length, 1, event);
    assert.deepEqual(handlerOf(event), { type: 'command', command: 'node', args: ['${QODER_PLUGIN_ROOT}/bin/hook.mjs', 'qoder', event], timeout: handlerOf(event).timeout });
    assert.ok(handlerOf(event).timeout > 0, event);
  }
  assert.equal(handlerOf('UserPromptSubmit').timeout * 1000, qoder.budgets.prompt, 'the recall and command budget is the hook timeout');
});

test('the tool hooks fire for the shell and edit tools only, and a compaction starts no session', () => {
  const matches = (event, value) => hooks[event][0].matcher.split('|').includes(value);
  for (const tool of EDIT_TOOLS) assert.ok(matches('PreToolUse', tool), tool);
  for (const tool of SHELL_TOOLS) assert.equal(matches('PreToolUse', tool), false, tool);
  for (const event of ['PostToolUse', 'PostToolUseFailure']) {
    for (const tool of [...SHELL_TOOLS, ...EDIT_TOOLS]) assert.ok(matches(event, tool), `${event} ${tool}`);
    assert.equal(matches(event, 'Read'), false, event);
  }
  assert.deepEqual(['startup', 'resume', 'clear', 'new', 'compact'].map((source) => matches('SessionStart', source)), [true, true, true, true, false]);
});

test('each shared command has a Qoder command file for the slash menu, described as the command is', () => {
  const files = readdirSync(at(`${DIST}/commands/`)).sort();
  assert.deepEqual(files, COMMANDS.map((command) => `${command.name}.md`).sort());
  for (const command of COMMANDS) {
    const source = readFileSync(at(`${DIST}/commands/${command.name}.md`), 'utf8');
    assert.equal(JSON.parse(/^description: (.+)$/m.exec(source)[1]), command.description, command.name);
    assert.equal(/^argument-hint: (.+)$/m.exec(source)?.[1], command.hint && JSON.stringify(command.hint), command.name);
  }
});

test('the marketplace Qoder reads first at the repository root installs dist/qoder from the release branch', () => {
  const marketplace = json('.qoder-plugin/marketplace.json');
  const manifest = json(`${DIST}/.qoder-plugin/plugin.json`);
  const [entry, ...rest] = marketplace.plugins;
  assert.deepEqual(rest, []);
  assert.deepEqual(entry.source, { source: 'git-subdir', url: 'https://github.com/EvoMap/evolver-agent-plugin.git', path: 'dist/qoder', ref: 'release' });
  assert.equal(json('package.json').scripts.pack, 'node scripts/pack.mjs all dist');
  assert.ok(packedHosts().includes('qoder'));
  assert.equal(entry.name, manifest.name);
  assert.equal('version' in entry, false, 'the packed manifest carries the release tag\'s version');
  assert.equal(`${entry.name}@${marketplace.name}`, 'evolver-plugin@evomap');
});

test('the manifest and every component sit at the packed folder\'s root, where Qoder looks for them', () => {
  const root = packSpecOf('qoder').root;
  assert.equal(root['.qoder-plugin/plugin.json'], `${DIST}/.qoder-plugin/plugin.json`);
  assert.equal(root['hooks/hooks.json'], `${DIST}/hooks/hooks.json`);
  const folder = packedPlugin();
  const manifest = JSON.parse(readFileSync(join(folder, '.qoder-plugin', 'plugin.json'), 'utf8'));
  assert.deepEqual([manifest.name, manifest.license, manifest.author.name], ['evolver-plugin', 'MIT', 'EvoMap']);
  assert.equal(manifest.version, json('hosts/codex/dist/.codex-plugin/plugin.json').version, 'the version every host ships');
  for (const path of [manifest.hooks, manifest.commands]) assert.ok(existsSync(join(folder, path)), path);
  for (const file of ['bin/hook.mjs', 'bin/worker.mjs', 'bin/command.mjs', 'hosts/qoder/profile.js', 'README.md', 'LICENSE']) assert.ok(existsSync(join(folder, file)), file);
  assert.equal(JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')).type, 'module');
});

test('the packed folder holds nothing else Qoder would load: no skill, agent, MCP server, Claude Code manifest or other host', () => {
  const folder = packedPlugin();
  for (const path of ['skills', 'agents', 'output-styles', 'workflows', '.mcp.json', 'mcp.json', '.claude-plugin', 'hosts/claude-code', 'hosts/codex']) {
    assert.equal(existsSync(join(folder, path)), false, path);
  }
});

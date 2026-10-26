import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import cursor from '../../../agents/cursor/profile.js';
import { COMMANDS } from '../../../lib/app/commands/index.js';

const root = new URL('../../../', import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const DIST = 'agents/cursor/dist/';

// Cursor 3.27.6 rejects a whole hooks file that names one event outside this list.
const CURSOR_HOOK_EVENTS = new Set([
  'beforeShellExecution', 'beforeMCPExecution', 'afterShellExecution', 'afterMCPExecution', 'beforeReadFile', 'afterFileEdit',
  'beforeTabFileRead', 'afterTabFileEdit', 'stop', 'beforeSubmitPrompt', 'afterAgentResponse', 'afterAgentThought', 'sessionStart',
  'sessionEnd', 'preCompact', 'subagentStart', 'subagentStop', 'preToolUse', 'postToolUse', 'postToolUseFailure', 'workspaceOpen',
]);
const MANIFEST_FIELDS = new Set([
  'name', 'displayName', 'description', 'version', 'author', 'publisher', 'homepage', 'repository', 'license', 'logo', 'keywords',
  'category', 'tags', 'rules', 'agents', 'skills', 'commands', 'hooks', 'mcpServers', 'variables', 'minClientVersions',
]);

test('hooks.json is version 1 and registers every Cursor event of the profile on bin/hook.mjs, by its own name', () => {
  const { version, hooks } = readJson(`${DIST}hooks.json`);
  assert.equal(version, 1);
  assert.deepEqual(Object.keys(hooks).sort(), Object.keys(cursor.events).sort());
  for (const [event, [entry, ...rest]] of Object.entries(hooks)) {
    assert.ok(CURSOR_HOOK_EVENTS.has(event), event);
    assert.deepEqual(rest, []);
    assert.equal(entry.command, `node "\${CURSOR_PLUGIN_ROOT}/bin/hook.mjs" cursor ${event}`);
    assert.ok(entry.timeout > 0);
  }
  assert.equal(hooks.beforeSubmitPrompt[0].timeout * 1000, cursor.budgets.prompt, 'the recall budget is the hook timeout');
  assert.equal(hooks.preToolUse[0].matcher, '^(Write|Delete)$');
});

test('each shared command has a Cursor command file for the slash menu, described as the command is', () => {
  const files = readdirSync(new URL(`${DIST}commands/`, root)).sort();
  assert.deepEqual(files, COMMANDS.map((command) => `${command.name}.md`).sort());
  for (const command of COMMANDS) {
    const source = readFileSync(new URL(`${DIST}commands/${command.name}.md`, root), 'utf8');
    assert.equal(JSON.parse(/^description: (.+)$/m.exec(source)[1]), command.description, command.name);
  }
});

test("the manifest points Cursor into the agent's dist only: the Claude Code hooks, commands, skill and the agents folder stay out", () => {
  const plugin = readJson('.cursor-plugin/plugin.json');
  for (const field of Object.keys(plugin)) assert.ok(MANIFEST_FIELDS.has(field), `Cursor's schema has no field ${field}`);
  assert.equal(plugin.hooks, `./${DIST}hooks.json`);
  assert.equal(plugin.commands, `./${DIST}commands/`);
  assert.deepEqual(plugin.skills, [], 'an empty list replaces the discovery of skills/');
  assert.deepEqual(plugin.agents, [], 'an empty list replaces the discovery of agents/');
  assert.equal('mcpServers' in plugin || 'rules' in plugin, false);
  for (const path of [plugin.hooks, plugin.commands, plugin.logo]) assert.ok(existsSync(new URL(path, root)), path);
  for (const path of ['mcp.json', '.mcp.json', 'rules']) assert.equal(existsSync(new URL(path, root)), false, `Cursor would discover ${path}`);
});

test('the marketplace lists the plugin from the repository root, at the manifest version', () => {
  const plugin = readJson('.cursor-plugin/plugin.json');
  const market = readJson('.cursor-plugin/marketplace.json');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, plugin.name);
  assert.equal(market.plugins[0].source, '.');
  assert.equal(market.plugins[0].version, plugin.version);
  assert.equal(market.metadata.version, plugin.version);
});

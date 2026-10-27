import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COMMAND_NAMES, TAKES_NO_ARGUMENTS } from '../../../hosts/codex/commands.js';
import codex from '../../../hosts/codex/profile.js';
import { COMMANDS } from '../../../lib/app/commands/index.js';

const parse = (prompt) => codex.commands.parse({}, 'UserPromptSubmit', { prompt });

test('commands are typed into the prompt box and answered by the prompt hook, which keeps them from the model', () => {
  assert.equal(codex.commands.entry, 'intercept');
  assert.equal(codex.commands.answerReachesModel, false);
});

test('a prompt that is exactly a command is one, with or without a slash', () => {
  assert.deepEqual(parse('evolver-status'), { name: 'evolver-status', args: '' });
  assert.deepEqual(parse('  /evolver-status '), { name: 'evolver-status', args: '' });
  assert.deepEqual(parse('evolver-search  redis retries '), { name: 'evolver-search', args: 'redis retries' });
  assert.deepEqual(parse('evolver-drafts publish 2'), { name: 'evolver-drafts', args: 'publish 2' });
  assert.deepEqual(parse('evolver-evolve the\nretry'), { name: 'evolver-evolve', args: 'the\nretry' });
});

test('a prompt that only starts like a command stays a prompt', () => {
  assert.equal(parse('evolver-status why is recall so slow?'), null, 'evolver-status takes no argument');
  assert.equal(parse('evolver-agent-plugin fails to load, why?'), null);
  assert.equal(parse('evolver-core is missing'), null);
  assert.equal(parse('please run evolver-status'), null);
  assert.equal(parse('Write add.mjs with a test and run node --test.'), null);
});

test('the names are the plugin\'s commands, and only those without an argument hint refuse trailing text', () => {
  assert.deepEqual([...COMMAND_NAMES].sort(), COMMANDS.map((command) => command.name).sort());
  assert.deepEqual([...TAKES_NO_ARGUMENTS].sort(), COMMANDS.filter((command) => !command.hint).map((command) => command.name).sort());
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import qoder from '../../../hosts/qoder/profile.js';

const PAYLOADS = JSON.parse(readFileSync(new URL('../../fixtures/qoder/hook-payloads.json', import.meta.url), 'utf8'));
const parse = (prompt) => qoder.commands.parse({}, 'UserPromptSubmit', { prompt });

test('commands are answered by the prompt hook, which keeps them from the model', () => {
  assert.equal(qoder.commands.entry, 'intercept');
  assert.equal(qoder.commands.answerReachesModel, false);
});

test('UserPromptSubmit sees a command as typed, with the plugin namespace Qoder lists it under', () => {
  const typed = qoder.payload.prompt(PAYLOADS['UserPromptSubmit.command']);
  assert.equal(typed, '/evolver-plugin:evolver-search flaky redis retries');
  assert.deepEqual(parse(typed), { name: 'evolver-search', args: 'flaky redis retries' });
});

test('a command is typed with a slash, with or without the namespace, and keeps its argument text', () => {
  assert.deepEqual(parse('/evolver-status'), { name: 'evolver-status', args: '' });
  assert.deepEqual(parse('  /evolver-plugin:evolver-status '), { name: 'evolver-status', args: '' });
  assert.deepEqual(parse('/evolver-drafts publish 2'), { name: 'evolver-drafts', args: 'publish 2' });
  assert.deepEqual(parse('/evolver-evolve the\nretry'), { name: 'evolver-evolve', args: 'the\nretry' });
});

test('text after a command that takes none is dropped: Qoder would hand the model its hooks-are-off fallback', () => {
  assert.deepEqual(parse('/evolver-status why is recall so slow?'), { name: 'evolver-status', args: '' });
  assert.deepEqual(parse('/evolver-plugin:evolver-login now'), { name: 'evolver-login', args: '' });
});

test('a prompt that only looks like a command stays a prompt', () => {
  assert.equal(parse('evolver-status'), null, 'Qoder commands start with a slash');
  assert.equal(parse('/other-plugin:evolver-status'), null);
  assert.equal(parse('/evolver-core is missing'), null);
  assert.equal(parse(PAYLOADS.UserPromptSubmit.prompt), null);
});

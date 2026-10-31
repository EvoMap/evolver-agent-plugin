import assert from 'node:assert/strict';
import { test } from 'node:test';

import profile from '../../../hosts/minimax/profile.js';
import { createDriver } from '../../../lib/agent/driver.js';
import { memoryPorts } from '../../app/memory-ports.js';

const parse = prompt => profile.commands.parse({ session_id: 's1' }, 'UserPromptSubmit', { prompt, env: {} });
const payload = { session_id: 's1', turn_id: 't1', cwd: '/project' };

test('background command arguments remain data, including shell-shaped text and apostrophes', () => {
  assert.deepEqual(parse("evolver-search it's a retry; $(whoami)"), { name: 'evolver-search', args: "it's a retry; $(whoami)", background: true });
});

test('native commands accept exact names with or without a slash and leave ordinary prompts alone', () => {
  for (const command of ['evolver-status', '/evolver-status']) assert.deepEqual(parse(command), { name: 'evolver-status', args: '' });
  assert.deepEqual(parse('/evolver-status recall off'), { name: 'evolver-status', args: 'recall off' });
  assert.deepEqual(parse('evolver-status auto-distill on'), { name: 'evolver-status', args: 'auto-distill on' });
  for (const text of ['please run evolver-status', 'evolver-status explain this error', 'evolver-unknown']) assert.equal(parse(text), null);
  assert.equal(parse('evolver-run --dry-run').background, true);
  assert.equal(parse('evolver-distill retries').background, true);
  assert.deepEqual(parse('evolver-status job a'), { name: 'evolver-status', args: 'job a' });
});

test('status configures settings without a model turn; slow commands are admitted with their exact session and project', async () => {
  const made = memoryPorts();
  made.ports.settings = { recall: true, autoDistill: true, configure: patch => Object.assign(made.ports.settings, patch) };
  made.ports.cli.run = () => { throw new Error('a long CLI must never run in a native hook'); };
  let admitted;
  made.ports.commandJobs = { enqueue: at => { admitted = at; return { ok: true, text: 'Job queued.' }; } };
  const driver = createDriver({ profile, ports: made.ports, transcripts: { size: () => 0, readSince: () => '' }, lifetime: 'resident', env: {} });
  const answer = await driver.handle('UserPromptSubmit', { ...payload, prompt: '/evolver-status recall off' });
  assert.equal(answer.decision, 'block');
  assert.match(answer.systemMessage, /Recall: off/);
  assert.equal(made.ports.settings.recall, false);
  assert.equal(made.sessions.get('s1'), undefined);
  const long = await driver.handle('UserPromptSubmit', { ...payload, prompt: 'evolver-run --dry-run' });
  assert.equal(long.decision, 'block');
  assert.match(long.reason, /Job queued/);
  assert.deepEqual(admitted, { sessionId: 's1', projectDir: '/project', name: 'evolver-run', args: '--dry-run', background: true });
  assert.equal(made.sessions.get('s1'), undefined);
});

test('the evolution checkpoint reaches the agent through context, while status remains a user message', async () => {
  const made = memoryPorts();
  const driver = createDriver({ profile, ports: made.ports, transcripts: { size: () => 0, readSince: () => '' }, lifetime: 'resident', env: {} });
  const checkpoint = await driver.handle('UserPromptSubmit', { ...payload, prompt: '/evolver-evolve retries' });
  assert.match(checkpoint.hookSpecificOutput.additionalContext, /Take a deliberate evolution step/);
  assert.match(checkpoint.hookSpecificOutput.additionalContext, /Focus on: retries/);
  assert.equal(checkpoint.decision, undefined);
  const status = await driver.handle('UserPromptSubmit', { ...payload, prompt: 'evolver-status' });
  assert.equal(status.decision, 'block');
  assert.equal(status.hookSpecificOutput, undefined);
});

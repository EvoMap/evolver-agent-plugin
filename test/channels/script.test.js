import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';

import { defineProfile } from '../../lib/agent/profile.js';
import { runCommandScript } from '../../lib/channels/script/runner.js';
import { fakeProxy } from '../helpers/fake-proxy.js';

// A host whose own readers know nothing of a script: the channel must not need them.
const profile = defineProfile({
  name: 'testscript',
  label: 'Test Script',
  events: { Prompt: 'prompt' },
  payload: { sessionId: (payload) => payload.conversationId ?? null, prompt: () => '' },
  evidence: { toolNote: () => null, editedFile: () => null },
  commands: {
    entry: 'inline-script',
    sessionOf: (env) => env.TEST_SESSION_ID ?? null,
    scriptAnswer: (result, script) => `${result.text}\n[${script.session_id} script ${script.script.endsWith(join('bin', 'command.mjs'))} nonce ${script.nonce.length}]`,
  },
});

let proxy;
before(async () => { proxy = await fakeProxy(); });
after(() => proxy.close());

function run(name, { input = '', argv = [], env = {}, stdin = Readable.from([input]), host = profile } = {}) {
  return new Promise((resolve) => {
    let written = '';
    runCommandScript('testscript', name, {
      argv, stdin, env: { ...proxy.env, ...env },
      stdout: { write: (text, done) => { written += text; done(); } }, exit: () => resolve(written), profileOf: async () => host,
    });
  });
}

test('a command script answers whatever the host\'s own readers would make of it, in the session the shell names', async () => {
  assert.equal(await run('evolver-drafts', { env: { TEST_SESSION_ID: 's1' } }), 'No distilled drafts are waiting.\n[s1 script true nonce 16]');
});

test('from a terminal, with no session, a command still answers', async () => {
  assert.equal(await run('evolver-drafts'), 'No distilled drafts are waiting.\n[null script true nonce 16]');
});

test('arguments come from the command line, else from stdin', async () => {
  assert.match(await run('evolver-drafts', { argv: ['publish', '3'] }), /^No draft matches "3"/);
  assert.match(await run('evolver-drafts', { input: 'discard 2\n' }), /^No draft matches "2"/);
});

test('a search from a terminal books its strategy on no session, so the same search finds it again', async () => {
  const first = await run('evolver-search', { argv: ['flaky', 'redis', 'connection', 'retries'] });
  assert.match(first, /Fix flaky Redis connection retries/);
  assert.equal(await run('evolver-search', { argv: ['flaky', 'redis', 'connection', 'retries'] }), first);
});

test('a Gene posted for no candidate says there is nothing to distill', async () => {
  assert.match(await run('evolver-distill', { input: '{"summary":"s"}', argv: ['--post', '123'] }), /^Nothing to distill yet/);
});

test('a host whose commands run only from a terminal never waits on a stdin held open', async () => {
  const terminalOnly = defineProfile({ ...profile, commands: { entry: 'cli-only' } });
  const heldOpen = () => new Readable({ read() {} });
  assert.equal(await run('evolver-drafts', { stdin: heldOpen(), host: terminalOnly }), 'No distilled drafts are waiting.');
  assert.match(await run('evolver-nope', { stdin: heldOpen(), host: terminalOnly }), /^Unknown command evolver-nope\. Usage: /);
});

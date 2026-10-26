import assert from 'node:assert/strict';
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
    scriptAnswer: (result, script) => `${result.text}\n[${script.session_id} script ${script.script.endsWith('bin/command.mjs')} nonce ${script.nonce.length}]`,
  },
});

let proxy;
before(async () => { proxy = await fakeProxy(); });
after(() => proxy.close());

function run(name, { input = '', argv = [], env = {} } = {}) {
  return new Promise((resolve) => {
    let written = '';
    runCommandScript('testscript', name, {
      argv, stdin: Readable.from([input]), env: { ...proxy.env, ...env },
      stdout: { write: (text, done) => { written += text; done(); } }, exit: () => resolve(written), profileOf: async () => profile,
    });
  });
}

test('a command script answers whatever the host\'s own readers would make of it, in the session the shell names', async () => {
  assert.equal(await run('evolver-drafts', { env: { TEST_SESSION_ID: 's1' } }), 'No distilled drafts are waiting.\n[s1 script true nonce 16]');
});

test('from a terminal, with no session, a command still answers', async () => {
  assert.equal(await run('evolver-drafts'), 'No distilled drafts are waiting.\n[terminal script true nonce 16]');
});

test('arguments come from the command line, else from stdin', async () => {
  assert.match(await run('evolver-drafts', { argv: ['publish', '3'] }), /^No draft matches "3"/);
  assert.match(await run('evolver-drafts', { input: 'discard 2\n' }), /^No draft matches "2"/);
});

test('a Gene posted for no candidate says there is nothing to distill', async () => {
  assert.match(await run('evolver-distill', { input: '{"summary":"s"}', argv: ['--post', '123'] }), /^Nothing to distill yet/);
});

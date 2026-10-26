import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';

import { defineProfile } from '../../lib/agent/profile.js';
import { SCRIPT_EVENTS, runCommandScript } from '../../lib/channels/script/runner.js';
import { fakeProxy } from '../helpers/fake-proxy.js';

const profile = defineProfile({
  name: 'testscript',
  label: 'Test Script',
  events: { [SCRIPT_EVENTS.COMMAND]: 'command', [SCRIPT_EVENTS.AGENT_GENE]: 'agentGene' },
  evidence: { toolNote: () => null, editedFile: () => null },
  commands: { entry: 'inline-script', sessionOf: (env) => env.TEST_SESSION_ID },
  reply: { command: (result, hostEvent, payload) => `${result.text}\n[script ${payload.script.endsWith('bin/command.mjs')} nonce ${payload.nonce.length}]` },
});

let proxy;
before(async () => { proxy = await fakeProxy(); });
after(() => proxy.close());

function run(name, input, argv = []) {
  return new Promise((resolve) => {
    let written = '';
    runCommandScript('testscript', name, {
      argv, stdin: Readable.from([input]), env: { ...proxy.env, TEST_SESSION_ID: 's1' },
      stdout: { write: (text, done) => { written += text; done(); } }, exit: () => resolve(written), profileOf: async () => profile,
    });
  });
}

test('a command script reads its arguments from stdin and prints the plugin\'s answer as text', async () => {
  const answer = await run('evolver-drafts', '');
  assert.match(answer, /^No distilled drafts are waiting\.\n\[script true nonce 16\]$/);
});

test('a Gene posted for no candidate says there is nothing to distill', async () => {
  assert.match(await run('evolver-distill', '{"summary":"s"}', ['--post', '123']), /^Nothing to distill yet/);
});

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';

import { defineProfile } from '../../lib/agent/profile.js';
import { runHookProcess } from '../../lib/channels/hook/runner.js';
import { PROMPT } from '../app/memory-ports.js';
import { fakeProxy } from '../helpers/fake-proxy.js';

const profile = defineProfile({
  name: 'testhook',
  label: 'Test Hook',
  events: { UserPromptSubmit: 'prompt', Stop: 'turnEnd' },
  evidence: { toolNote: () => null, editedFile: () => null },
  reply: { empty: (hostEvent) => ({ empty: hostEvent }) },
});

let proxy;
before(async () => { proxy = await fakeProxy(); });
after(() => proxy.close());

function invoke(hostEvent, payload, { env = proxy.env, raw } = {}) {
  return new Promise((resolve) => {
    let written = '';
    const stdout = { write: (text, done) => { written += text; done(); } };
    const stdin = Readable.from([raw ?? JSON.stringify(payload)]);
    runHookProcess('testhook', hostEvent, { stdin, stdout, env, exit: () => resolve(JSON.parse(written)), profileOf: async () => profile });
  });
}

test('a hook process reads its payload, answers the strategy as JSON and exits 0', async () => {
  const answer = await invoke('UserPromptSubmit', { session_id: 's1', cwd: '/proj', prompt: PROMPT });
  assert.ok(answer.hookSpecificOutput.additionalContext.endsWith('Apply them where they fit.'));
  assert.ok(proxy.requests.some((request) => request.path === '/asset/fetch'));
});

test('inside the plugin\'s own headless run, a hook answers the empty reply and does nothing', async () => {
  const before = proxy.requests.length;
  const answer = await invoke('UserPromptSubmit', { session_id: 's2', prompt: PROMPT }, { env: { ...proxy.env, EVOLVER_HEADLESS: '1' } });
  assert.deepEqual(answer, { empty: 'UserPromptSubmit' });
  assert.equal(proxy.requests.length, before);
});

test('a payload that is not JSON still gets an answer', async () => {
  assert.deepEqual(await invoke('UserPromptSubmit', null, { raw: '{not json' }), { empty: 'UserPromptSubmit' });
});

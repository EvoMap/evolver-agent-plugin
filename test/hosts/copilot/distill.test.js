// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import profile from '../../../hosts/copilot/profile.js';
import { runCommandScript } from '../../../lib/channels/script/runner.js';
import { fileStoresOf } from '../../../lib/runtime/store/file-stores.js';
import { DRAFTED, IR } from '../../app/work-turns.js';
import { closeProxyWhenSettled, fakeProxy } from '../../helpers/fake-proxy.js';

async function terminal(env, name, { argv = [], input = '' } = {}) {
  let output = '';
  await runCommandScript('copilot', name, {
    argv, env, stdin: Readable.from([input]),
    stdout: { write: (text, done) => { output += text; done(); } },
    exit: () => {},
  });
  return output;
}

function candidate(at) {
  return {
    at, changedAt: at, attempts: 0, turns: [{
      turn: 1, at, prompt: 'Repair the flaky Redis retries.',
      steps: [{ kind: 'check', command: 'npm test', exit: 0, failed: false }],
      answer: 'The retries pass after the repair.',
    }],
  };
}

test('Copilot submits the exact writtenFor range privately and only lists a draft when the Proxy returns one', async (t) => {
  for (const status of ['draft', 'stored']) await t.test(status, async (t) => {
    const proxy = await fakeProxy({ distillAnswer: { ...DRAFTED, status } });
    t.after(() => closeProxyWhenSettled(proxy));
    const env = {
      ...proxy.env, COPILOT_HOME: join(proxy.env.HOME, '.copilot'),
      EVOLVER_AUTO_DISTILL: 'off', EVOLVER_SESSION_ID: '',
    };
    const sessionId = 'copilot-original-session';
    const selected = { ...env, EVOLVER_SESSION_ID: sessionId };
    const stores = fileStoresOf({ dir: profile.stateDir(env), agent: profile.name });
    const start = Date.now();
    await stores.candidates.update(() => ({ [sessionId]: candidate(start) }));
    const prompt = await terminal(selected, 'evolver-distill');
    const writtenFor = /^v2-[A-Za-z0-9_-]{43}$/m.exec(prompt)?.[0];
    assert.ok(writtenFor, 'the terminal gives the exact reference to the model prompt');

    // A newer session must never take over the IR that Copilot wrote for this one.
    const newer = candidate(start + 1);
    await stores.candidates.update((ranges) => ({ ...ranges, 'another-session': newer }));
    const result = await terminal(env, 'evolver-distill', { argv: ['--post', writtenFor], input: JSON.stringify(IR) });
    const posted = proxy.requests.filter(({ path }) => path === '/conversation/distill');
    assert.deepEqual(posted.map(({ method, body }) => [method, body.session_id, body.persist, body.publish]), [
      ['POST', 'copilot:copilot-original-session', false, false],
    ]);
    assert.deepEqual(await stores.candidates.read(), { 'another-session': newer });
    assert.equal(proxy.requests.some(({ path }) => path === '/asset/submit' || path === '/asset/reverify'), false);

    const drafts = await terminal(env, 'evolver-drafts');
    if (status === 'draft') {
      assert.match(result, /Distilled "Stabilise Redis retries" into a draft/);
      assert.match(drafts, /Stabilise Redis retries/);
    } else {
      assert.match(result, /Stored "Stabilise Redis retries"/);
      assert.equal(drafts, 'No distilled drafts are waiting.');
    }
  });
});

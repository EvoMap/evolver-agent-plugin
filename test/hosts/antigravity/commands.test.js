import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { pack } from '../../../scripts/pack.mjs';
import { fakeProxy } from '../../helpers/fake-proxy.js';

let proxy;
let packed;
before(async () => {
  proxy = await fakeProxy();
  packed = mkdtempSync(join(tmpdir(), 'evolver-antigravity-cmd-'));
  pack('antigravity', packed);
});
after(() => {
  proxy.close();
  rmSync(packed, { recursive: true, force: true });
});

function command(name, args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(packed, 'bin', 'command.mjs'), 'antigravity', name, ...args], { env: { ...proxy.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

test('every command answers from a terminal, from the installed folder, with its arguments on the command line', async () => {
  const status = await command('evolver-status');
  assert.equal(status.code, 0);
  assert.match(status.stdout, /Evolver Proxy running/);
  assert.equal((await command('evolver-drafts')).stdout, 'No distilled drafts are waiting.');
  assert.match((await command('evolver-drafts', ['publish', '3'])).stdout, /^No draft matches "3"/);
  assert.match((await command('evolver-search', ['fix', 'the', 'flaky', 'redis', 'connection', 'retries'])).stdout, /^\[Evolution Memory\] Fix flaky Redis connection retries/);
});

test('a distill from a terminal takes the newest candidate of any conversation', async () => {
  const state = join(proxy.env.HOME, '.evolver', 'state');
  mkdirSync(state, { recursive: true });
  const candidate = (at) => ({ prompt: 'p', commands: ['npm test'], paths: [], checks: [{ command: 'npm test', failed: false }], answer: 'a', model: null, turn: 1, pid: null, attempts: 0, at, closed: true });
  writeFileSync(join(state, 'antigravity-distill-pending.json'), JSON.stringify({ older: candidate(1), newer: candidate(2) }));
  assert.match((await command('evolver-distill')).stdout, /^Distillation no_model/);
});

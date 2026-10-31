import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { commandJobsOf } from '../../lib/runtime/command-jobs.js';
import { runProcess } from '../../lib/runtime/process/spawn.js';

const invocation = { name: 'evolver-search', args: "it's a query; $(whoami)", sessionId: 's1', projectDir: process.cwd() };

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-command-jobs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const jobs = commandJobsOf({ dir, agent: 'minimax', env: process.env, accepts: name => name === invocation.name, start: async () => ({ pid: process.pid }), ...options });
  const read = () => JSON.parse(readFileSync(join(dir, 'commands.json'), 'utf8'));
  const id = () => read().at(-1).id;
  return { jobs, read, id, dir };
}

test('command admission is serial, preserves arguments and session, persists results, and never replays', async t => {
  const f = fixture(t);
  assert.equal((await f.jobs.enqueue(invocation)).ok, true);
  assert.equal((await f.jobs.enqueue(invocation)).ok, false);
  let calls = 0;
  const run = async at => { calls++; for (const key of Object.keys(invocation)) assert.equal(at[key], invocation[key]); return { ok: true, text: 'result' }; };
  assert.equal(await f.jobs.run(f.id(), run), true);
  assert.equal(await f.jobs.run(f.id(), run), false);
  assert.equal(calls, 1);
  assert.match((await f.jobs.status(f.id())).text, /completed\.\nresult/);
  assert.equal((await f.jobs.enqueue({ ...invocation, name: '../../arbitrary' })).ok, false);
  assert.equal(await f.jobs.run('../elsewhere', run), false);
});

test('queued cancellation runs nothing; active cancellation aborts its own process and records the result', async t => {
  const f = fixture(t);
  await f.jobs.enqueue(invocation);
  await f.jobs.cancel(f.id());
  assert.equal(await f.jobs.run(f.id(), () => { throw new Error('must not run'); }), false);
  await f.jobs.enqueue(invocation);
  const controller = new AbortController();
  const started = once(controller.signal, 'abort');
  const running = f.jobs.run(f.id(), async (at, signal) => {
    controller.abort();
    const result = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal });
    assert.equal(result.error.code, 'ABORT_ERR');
    return { ok: false, text: 'child stopped' };
  });
  await started;
  await f.jobs.cancel(f.id());
  await running;
  assert.equal(f.read().at(-1).state, 'cancelled');
  assert.match((await f.jobs.status(f.id())).text, /child stopped/);
});

test('a dead worker is interrupted, spawn failure is explicit, and corrupt state is never overwritten', async t => {
  const f = fixture(t, { isGone: () => true });
  await f.jobs.enqueue(invocation);
  assert.match((await f.jobs.status(f.id())).text, /interrupted/);
  assert.equal(await f.jobs.run(f.id(), () => { throw new Error('no replay'); }), false);
  const missing = fixture(t, { start: async () => ({ missing: true }) });
  assert.equal((await missing.jobs.enqueue(invocation)).ok, false);
  assert.match((await missing.jobs.status()).text, /no command ran/);
  writeFileSync(join(f.dir, 'commands.json'), '{broken');
  await assert.rejects(f.jobs.enqueue(invocation), /unreadable/);
  assert.equal(readFileSync(join(f.dir, 'commands.json'), 'utf8'), '{broken');
});

test('worker results and history have fixed storage bounds', async t => {
  const f = fixture(t);
  for (let i = 0; i < 22; i++) {
    await f.jobs.enqueue(invocation);
    await f.jobs.run(f.id(), async () => ({ ok: true, text: 'x'.repeat(20_000) }));
  }
  assert.equal(f.read().length, 20);
  assert.equal(f.read().at(-1).text.length, 16_000);
});

test('escaped Unicode history stays readable and bounded after many commands', async t => {
  const f = fixture(t);
  for (let i = 0; i < 22; i++) {
    const admitted = await f.jobs.enqueue({ ...invocation, args: '\u0000'.repeat(16_000) });
    assert.equal(admitted.ok, true);
    await f.jobs.run(f.id(), async () => ({ ok: true, text: '\u0001'.repeat(16_000) }));
    assert.equal((await f.jobs.status(f.id())).ok, true);
    assert.ok(Buffer.byteLength(readFileSync(join(f.dir, 'commands.json'), 'utf8')) <= 1024 * 1024);
  }
  assert.equal(f.read().at(-1).state, 'completed');
});

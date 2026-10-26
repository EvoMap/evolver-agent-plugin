import assert from 'node:assert/strict';
import { test } from 'node:test';

import { waitBudgetOf } from '../../lib/runtime/budget.js';
import { modelRunnerOf } from '../../lib/runtime/model-executor.js';
import { ownerProbeOf } from '../../lib/runtime/process/owner.js';
import { cmdArgument, runProcess } from '../../lib/runtime/process/spawn.js';

const node = process.execPath;

test('a run gets its input on stdin and the headless marker only when asked', async () => {
  const echo = ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s+"|"+(process.env.EVOLVER_HEADLESS??"-")))'];
  assert.equal((await runProcess(node, echo, { input: 'hi' })).stdout, 'hi|-');
  assert.equal((await runProcess(node, echo, { input: 'hi', headless: true })).stdout, 'hi|1');
});

test('a run past its timeout is killed and says so; a missing command reads as ENOENT', async () => {
  const slow = await runProcess(node, ['-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 200 });
  assert.equal(slow.error.code, 'ETIMEDOUT');
  assert.equal((await runProcess('evolver-no-such-command-xyz', [])).error.code, 'ENOENT');
});

test('a cancelled run is ended and reported cancelled', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const result = await runProcess(node, ['-e', 'setTimeout(()=>{},60000)'], { signal: controller.signal });
  assert.equal(result.error.code, 'ABORT_ERR');
});

test('cmd.exe metacharacters in an argument are quoted and escaped so none runs', () => {
  assert.equal(cmdArgument('a&b'), '^^^"a^^^&b^^^"');
});

test('the owner is this process, the parent past a shell, or the nearest named ancestor', () => {
  const table = new Map([[process.ppid, { ppid: 50, name: 'zsh' }], [50, { ppid: 40, name: 'Cursor Helper' }], [40, { ppid: 1, name: 'codex' }]]);
  const probe = (pid) => table.get(pid) ?? null;
  assert.equal(ownerProbeOf('self').current(), process.pid);
  assert.equal(ownerProbeOf('parent', { probe, platform: 'darwin' }).current(), 50);
  assert.equal(ownerProbeOf({ ancestor: /^codex/ }, { probe, platform: 'darwin' }).current(), 40);
  assert.equal(ownerProbeOf('parent', { probe, platform: 'win32' }).current(), null);
});

test('a hook waits what is left of its budget, never less than a floor', () => {
  assert.equal(waitBudgetOf({ prompt: 8_000 }, 'prompt', { startedAt: 0, now: 500 }), 6_000);
  assert.equal(waitBudgetOf({ prompt: 7_000 }, 'prompt', { startedAt: 0, now: 500 }), 5_000);
  assert.equal(waitBudgetOf({ prompt: 660_000 }, 'prompt', { startedAt: 0, now: 0 }), 6_000);
  assert.equal(waitBudgetOf({ prompt: 1_000 }, 'prompt', { startedAt: 0, now: 0 }), 500);
  assert.equal(waitBudgetOf({}, 'prompt', { lifetime: 'resident' }), 6_000);
});

test('a cli model declaration runs headless and parses its answer; none or in-session means no runner', async () => {
  const runner = modelRunnerOf({
    kind: 'cli',
    command: () => node,
    args: () => ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({result:s.toUpperCase(),marker:process.env.EVOLVER_HEADLESS})))'],
    parse: ({ stdout }) => ({ answer: JSON.parse(stdout).result + JSON.parse(stdout).marker }),
  });
  assert.equal((await runner.complete('m', 'gene', AbortSignal.timeout(5_000))).answer, 'GENE1');
  assert.equal(modelRunnerOf(null), null);
  assert.equal(modelRunnerOf({ kind: 'in-session' }), null);
  assert.equal(modelRunnerOf({ kind: 'cli', command: () => null }), null);
});

test('the CLI runs the plugin-installed engine in the project directory, before any on PATH', async () => {
  const { evolverCliOf } = await import('../../lib/runtime/cli-executor.js');
  const { mkdtempSync, writeFileSync, realpathSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'evolver-cli-')));
  const entry = join(dir, 'evolver.mjs');
  writeFileSync(entry, 'process.stdout.write(process.argv.slice(2).join(" ") + " in " + process.cwd())');
  const cli = evolverCliOf({ enginePrefix: '/managed', managedEngine: (prefix) => (prefix === '/managed' ? { path: entry } : null) });
  assert.deepEqual(await cli.run(['run', '--dry-run'], { cwd: dir }), { ok: true, text: `run --dry-run in ${dir}` });
});

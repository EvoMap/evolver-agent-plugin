import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { isHeadlessRun } from '../../lib/runtime/headless.js';
import { modelRunnerOf } from '../../lib/runtime/model-executor.js';
import { ownerProbeOf } from '../../lib/runtime/process/owner.js';

test('Windows hooks find the host beyond cmd.exe and PowerShell, and fail closed for an unknown parent', () => {
  const table = new Map([
    [process.ppid, { ppid: 50, name: 'cmd.exe' }],
    [50, { ppid: 45, name: 'pwsh.exe' }],
    [45, { ppid: 40, name: 'BASH.EXE' }],
    [40, { ppid: 1, name: 'node.exe' }],
  ]);
  assert.equal(ownerProbeOf('parent', { platform: 'win32', probe: pid => table.get(pid) ?? null }).current(), 40);
  assert.equal(ownerProbeOf('parent', { platform: 'win32', probe: () => null }).current(), null);
});

test('failed and cancelled model runs also remove their private configuration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'evolver-config-failure-'));
  const source = join(home, 'config.yaml'); writeFileSync(source, 'synthetic-private-config');
  try {
    for (const cancel of [false, true]) {
      let scratch;
      const runner = modelRunnerOf({
        kind: 'cli', command: () => process.execPath,
        configFile: { source: () => source, prepare: text => text },
        args: (model, prompt, context) => { scratch = context.workdir; return ['-e', cancel ? 'setTimeout(()=>{},60000)' : 'process.exit(1)']; },
        parse: () => { throw new Error('safe model failure'); },
      });
      await assert.rejects(runner.complete(null, 'prompt', AbortSignal.timeout(cancel ? 150 : 5000)));
      assert.ok(scratch);
      assert.equal(existsSync(scratch), false);
      assert.equal(readFileSync(source, 'utf8'), 'synthetic-private-config');
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a private model folder suppresses hooks after the host strips the inherited environment', () => {
  const folder = mkdtempSync(join(tmpdir(), 'evolver-model-'));
  try {
    writeFileSync(join(folder, '.evolver-headless'), 'EVOLVER_HEADLESS=1\n', { mode: 0o600 });
    assert.equal(isHeadlessRun({}, folder), true);
    writeFileSync(join(folder, '.evolver-headless'), 'not a runtime marker');
    assert.equal(isHeadlessRun({}, folder), false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('a CLI gets a private per-run configuration and derived environment, with the source intact and scratch removed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'evolver-config-test-'));
  const source = join(home, 'config.yaml');
  const original = 'defaultModel: fixture/model\n';
  writeFileSync(source, original);
  try {
    const runner = modelRunnerOf({
      kind: 'cli', command: () => process.execPath, workdir: 'empty',
      env: env => ({ ROUTE_PROBE: env.NATIVE_HOME }),
      configFile: { source: env => join(env.NATIVE_HOME, 'config.yaml'), prepare: text => `<<:\n${text.split('\n').map(line => `  ${line}`).join('\n')}\nprobe: true\n` },
      args: (model, prompt, { configPath }) => ['-e', 'const fs=require("fs");process.stdout.write(JSON.stringify({config:fs.readFileSync(process.argv[1],"utf8"),mode:fs.statSync(process.argv[1]).mode&511,cwd:process.cwd(),route:process.env.ROUTE_PROBE,marker:fs.readFileSync(".evolver-headless","utf8")}))', configPath],
      parse: ({ stdout }) => ({ answer: JSON.parse(stdout) }),
    }, { ...process.env, NATIVE_HOME: home });
    const { answer } = await runner.complete(null, 'a prompt', AbortSignal.timeout(10_000));
    assert.match(answer.config, /defaultModel: fixture\/model/);
    assert.equal(answer.route, home);
    assert.equal(answer.marker, 'EVOLVER_HEADLESS=1\n');
    if (process.platform !== 'win32') assert.equal(answer.mode, 0o600);
    assert.equal(readFileSync(source, 'utf8'), original);
    assert.equal(existsSync(answer.cwd), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

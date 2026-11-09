import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { modelRunnerOf } from '../../lib/runtime/model-executor.js';
import { ownerIsGone } from '../../lib/runtime/process/owner.js';
import { runProcess } from '../../lib/runtime/process/spawn.js';

test('a Windows stdout matcher requires process-tree termination before starting a child', { skip: process.platform !== 'win32' }, () => {
  const runtime = new URL('../../lib/runtime/process/spawn.js', import.meta.url).href;
  const script = `
    for (const key of Object.keys(process.env)) if (/^(systemroot|windir|comspec)$/i.test(key)) delete process.env[key];
    process.report.getReport = () => ({ sharedObjects: [] });
    const { runProcess } = await import(${JSON.stringify(runtime)});
    const result = await runProcess(process.execPath, ['-e', 'console.log("unexpected child")'], { closeInputOn: () => false });
    console.log(JSON.stringify({ code: result.error?.code, stdout: result.stdout }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.deepEqual(JSON.parse(result.stdout), { code: 'ENOENT', stdout: '' });
});

test('a throwing stdout matcher returns its error and stops the owned process tree', async (t) => {
  const failure = new Error('the handshake matcher failed');
  let pids = [];
  t.after(() => { for (const pid of pids) if (!ownerIsGone(pid)) process.kill(pid); });
  const fixture = `
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    child.once('spawn', () => process.stdout.write(JSON.stringify([process.pid, child.pid]) + '\\n'));
    process.stdin.resume();
    setTimeout(() => process.exit(0), 5000);
  `;
  const result = await runProcess(process.execPath, ['-e', fixture], {
    timeoutMs: 2_000,
    closeInputOn: (line) => { pids = JSON.parse(line); throw failure; },
  });
  assert.equal(result.error, failure);
  assert.equal(pids.length, 2);
  for (const deadline = Date.now() + 2_000; pids.some(pid => !ownerIsGone(pid)) && Date.now() < deadline;) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(pids.map(ownerIsGone), [true, true]);
});

test('a throwing stdout matcher rejects model completion and removes its private configuration', async (t) => {
  const failure = new Error('the model handshake matcher failed');
  let scratch, pid;
  t.after(() => {
    if (pid && !ownerIsGone(pid)) process.kill(pid);
    if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const runner = modelRunnerOf({
    kind: 'cli', command: () => process.execPath, workdir: 'empty', timeoutMs: 2_000,
    workdirFiles: { 'private.json': 'synthetic private configuration' },
    env: (env, { workdir }) => { scratch = workdir; return {}; },
    args: () => ['-e', `process.stdout.write(JSON.stringify({pid:process.pid,config:require('node:fs').readFileSync('private.json','utf8')})+'\\n');process.stdin.resume();setTimeout(()=>{},5000)`],
    closeInputOn: (line) => {
      const row = JSON.parse(line);
      pid = row.pid;
      assert.equal(row.config, 'synthetic private configuration');
      throw failure;
    },
    parse: () => { throw new Error('a failed model handshake must not be parsed'); },
  });
  await assert.rejects(runner.complete(null, ''), error => error === failure);
  assert.ok(scratch);
  assert.equal(existsSync(scratch), false);
  assert.equal(ownerIsGone(pid), true);
});

test('an unbound model configuration gives the env callback the private config path and reads its derived source', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'evolver-model-env-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = join(home, 'native.yaml');
  writeFileSync(source, 'synthetic route');
  let scratch;
  const runner = modelRunnerOf({
    kind: 'cli', command: () => process.execPath, isolated: true,
    configFile: { source: env => join(env.INPUT_DIR, 'native.yaml'), prepare: text => text },
    env: (env, { workdir, configPath }) => {
      scratch = workdir;
      assert.equal(configPath, join(workdir, 'config.yaml'));
      return { INPUT_DIR: env.NATIVE_HOME, MODEL_CONFIG_PATH: configPath };
    },
    args: (model, prompt, { configPath }) => ['-e', 'process.stdout.write(JSON.stringify({path:process.env.MODEL_CONFIG_PATH,text:require("fs").readFileSync(process.env.MODEL_CONFIG_PATH,"utf8"),argument:process.argv[1]}))', configPath],
    parse: ({ stdout }) => ({ answer: JSON.parse(stdout) }),
  }, { NATIVE_HOME: home });
  const { answer } = await runner.complete(null, '', AbortSignal.timeout(5_000));
  assert.deepEqual(answer, { path: join(scratch, 'config.yaml'), text: 'synthetic route', argument: join(scratch, 'config.yaml') });
  assert.equal(existsSync(scratch), false);
  assert.equal(readFileSync(source, 'utf8'), 'synthetic route');
});

test('private model files reject paths outside the run folder before writing them', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'evolver-model-path-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const escaped = join(tmpdir(), `${basename(home)}-escape.json`);
  t.after(() => rmSync(escaped, { force: true }));
  for (const file of [`../${basename(home)}-escape.json`, join(home, 'absolute.json'), '.']) {
    let scratch;
    const runner = modelRunnerOf({
      kind: 'cli', command: () => process.execPath,
      workdirFiles: { [file]: 'synthetic private configuration' },
      env: (env, { workdir }) => { scratch = workdir; return {}; },
      args: () => ['-e', ''],
      parse: () => ({ answer: '' }),
    }, {});
    await assert.rejects(runner.complete(null, '', AbortSignal.timeout(5_000)), /Private model files must stay within their work directory/);
    assert.equal(scratch, undefined, 'invalid files fail before constructing the child environment');
  }
  assert.equal(existsSync(escaped), false);
  assert.equal(existsSync(join(home, 'absolute.json')), false);
});

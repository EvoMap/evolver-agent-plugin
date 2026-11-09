import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { modelRunnerOf } from '../../lib/runtime/model-executor.js';

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

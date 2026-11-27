import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

function invoke(hostEvent, payload, { env = proxy.env, raw, stderr } = {}) {
  return new Promise((resolve) => {
    let written = '';
    const stdout = { write: (text, done) => { written += text; done(); } };
    const stdin = Readable.from([raw ?? JSON.stringify(payload)]);
    runHookProcess('testhook', hostEvent, { stdin, stdout, stderr, env, exit: () => resolve(JSON.parse(written)), profileOf: async () => profile });
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

test('corrupt hook state stays intact and emits a diagnostic alongside the neutral reply', async () => {
  const dir = profile.stateDir(proxy.env);
  const key = createHash('sha256').update('s-corrupt').digest('hex').slice(0, 16);
  const file = join(dir, `testhook-session-${key}.json`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, '{"private text":');
  let diagnostic = '';
  const stderr = { write: (text, done) => { diagnostic += text; done(); } };

  assert.deepEqual(await invoke('UserPromptSubmit', { session_id: 's-corrupt', cwd: '/proj', prompt: PROMPT }, { stderr }), { empty: 'UserPromptSubmit' });
  assert.match(diagnostic, /EINVALIDSTATE/);
  assert.doesNotMatch(diagnostic, /private text/);
  assert.equal(readFileSync(file, 'utf8'), '{"private text":');
});

test('a failed Windows worker launch is reported by the hook', { skip: process.platform !== 'win32' }, () => {
  const runner = new URL('../../lib/channels/hook/runner.js', import.meta.url).href;
  const codex = new URL('../../hosts/codex/profile.js', import.meta.url).href;
  const home = join(proxy.env.HOME, 'missing-worker-cwd');
  const code = `
    import { runHookProcess } from ${JSON.stringify(runner)};
    import codex from ${JSON.stringify(codex)};
    await runHookProcess('codex', process.argv[1], {
      profileOf: async () => ({ ...codex, stateDir: () => process.env.TEST_HOOK_STATE }),
    });
  `;
  const invokeHook = (event) => spawnSync(process.execPath, ['--input-type=module', '-e', code, event], {
    input: JSON.stringify({ session_id: 's-worker-launch-failure', cwd: proxy.env.HOME }),
    env: { ...proxy.env, HOME: home, USERPROFILE: home, TEST_HOOK_STATE: join(proxy.env.HOME, 'hook-state') },
    encoding: 'utf8',
    timeout: 8_000,
    windowsHide: true,
  });
  const start = invokeHook('SessionStart');
  assert.ifError(start.error);
  assert.equal(start.status, 0);
  assert.match(JSON.parse(start.stdout).systemMessage ?? '', /could not confirm that the Windows background worker started/);
  assert.match(JSON.parse(start.stdout).systemMessage ?? '', /system \.NET Framework C# compiler.*temporary executables/);
  assert.equal(JSON.parse(start.stdout).continue, undefined);

  const end = invokeHook('SessionEnd');
  assert.ifError(end.error);
  assert.equal(end.status, 1);
  assert.match(end.stderr, /could not confirm that the Windows background worker started/);
  assert.match(end.stderr, /system \.NET Framework C# compiler.*temporary executables/);
  assert.doesNotMatch(start.stdout + end.stderr, /missing-worker-cwd/);
});

test('a Windows worker timeout after its PID is reported as unconfirmed by the hook', { skip: process.platform !== 'win32' }, () => {
  const runner = new URL('../../lib/channels/hook/runner.js', import.meta.url).href;
  const codex = new URL('../../hosts/codex/profile.js', import.meta.url).href;
  const marker = join(proxy.env.HOME, 'timed-out-bridge.json');
  const code = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { writeFileSync } from 'node:fs';
    const original = childProcess.spawnSync;
    childProcess.spawnSync = (command, args, options) => {
      if (command.endsWith('csc.exe')) return { status: 0 };
      if (/[\\\\/]worker\\.exe$/.test(command)) {
        writeFileSync(process.env.TEST_BRIDGE_MARKER, JSON.stringify({ event: process.argv[1], stdout: '1234\\n' }));
        return { status: null, stdout: '1234\\n', error: { code: 'ETIMEDOUT' } };
      }
      return original(command, args, options);
    };
    syncBuiltinESMExports();
    const { runHookProcess } = await import(${JSON.stringify(runner)});
    const { default: codex } = await import(${JSON.stringify(codex)});
    await runHookProcess('codex', process.argv[1], {
      profileOf: async () => ({ ...codex, stateDir: () => process.env.TEST_HOOK_STATE }),
    });
  `;
  const invokeHook = (event) => {
    writeFileSync(marker, 'not reached');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, event], {
      input: JSON.stringify({ session_id: 's-worker-timeout-after-pid', cwd: proxy.env.HOME }),
      env: { ...proxy.env, TEST_BRIDGE_MARKER: marker, TEST_HOOK_STATE: join(proxy.env.HOME, 'timed-out-hook-state') },
      encoding: 'utf8', timeout: 8_000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { event, stdout: '1234\n' }, 'the bridge timed out after a complete PID');
    return result;
  };
  const start = invokeHook('SessionStart');
  const end = invokeHook('SessionEnd');
  assert.equal(start.status, 0);
  assert.match(JSON.parse(start.stdout).systemMessage ?? '', /could not confirm that the Windows background worker started/);
  assert.equal(end.status, 1);
  assert.match(end.stderr, /could not confirm that the Windows background worker started/);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { pack } from '../../../scripts/pack.mjs';

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'TurnStarted', 'PreToolUse', 'Stop', 'StopFailure', 'Interrupt', 'SessionEnd', 'Notification'];

test('the Kimi bundle carries a native flat hook manifest and self-contained channel entries', t => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-kimi-pack-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  pack('kimi', dir, { version: '9.8.7' });
  const manifest = JSON.parse(readFileSync(join(dir, 'kimi.plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'evolver-plugin');
  assert.equal(manifest.version, '9.8.7');
  assert.deepEqual(manifest.hooks.map(hook => hook.event), EVENTS);
  for (const hook of manifest.hooks) {
    assert.equal(hook.command, `node bin/hook.mjs kimi ${hook.event}`);
    assert.equal(hook.timeout, hook.event === 'UserPromptSubmit' ? 10 : 3);
  }
  for (const entry of ['bin/hook.mjs', 'bin/worker.mjs', 'bin/command.mjs', 'hosts/kimi/profile.js', 'lib/runtime/process/windows-job.js']) assert.ok(existsSync(join(dir, entry)), entry);
  for (const extra of ['.claude-plugin', '.mcp.json', '.git', 'test', 'config.toml', 'credentials']) assert.equal(existsSync(join(dir, extra)), false, extra);
  assert.equal(readFileSync(join(dir, '.evolver-packed'), 'utf8').trim(), 'kimi');
  const system = Object.fromEntries(['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const child = spawnSync(process.execPath, [join(dir, 'bin/hook.mjs'), 'kimi', 'UserPromptSubmit'], {
    cwd: dir, input: '{"session_id":"smoke","prompt":"ignored"}', encoding: 'utf8',
    env: { ...system, HOME: dir, USERPROFILE: dir, KIMI_CODE_HOME: join(dir, 'private-native'), EVOLVER_HEADLESS: '1' },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {});
  assert.equal(existsSync(join(dir, 'private-native')), false, 'recursive completion creates no native profile or state');
});

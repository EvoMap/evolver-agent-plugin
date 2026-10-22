import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SIDECAR = fileURLToPath(new URL('../bin/evolver-io.mjs', import.meta.url));

function sidecar(command, request, home) {
  const ran = spawnSync(process.execPath, [SIDECAR, command], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  return { status: ran.status, answer: JSON.parse(ran.stdout) };
}

test('a turn capture is no longer a sidecar command', () => {
  const home = mkdtempSync(join(tmpdir(), 'evolver-home-'));
  const ran = sidecar('capture', { projectDir: home, turnReason: 'answer' }, home);
  assert.equal(ran.status, 2);
  assert.match(ran.answer.error, /unknown command: capture/);
});

test('a reuse report without an asset records nothing locally', () => {
  const home = mkdtempSync(join(tmpdir(), 'evolver-home-'));
  const ran = sidecar('record-reuse', { outcome: 'success' }, home);
  assert.equal(ran.status, 0);
  assert.equal(ran.answer.recorded, false);
});

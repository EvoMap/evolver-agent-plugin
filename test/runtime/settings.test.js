import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { settingsOf } from '../../lib/runtime/settings.js';

test('preferences survive a fresh hook with stripped environment and keep explicit environment overrides', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-preferences-'));
  try {
    const file = join(dir, 'settings.json');
    await settingsOf({}, file).configure({ recall: false });
    await settingsOf({}, file).configure({ autoDistill: false });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { recall: false, autoDistill: false });
    assert.equal(settingsOf({}, file).recall, false);
    assert.equal(settingsOf({}, file).autoDistill, false);
    assert.equal(settingsOf({ EVOLVER_RECALL: 'on' }, file).recall, true);
    assert.equal(settingsOf({ EVOLVER_AUTO_DISTILL: 'off' }, file).autoDistill, false);
    assert.deepEqual(settingsOf({ EVOLVER_RECALL: 'off' }), { recall: false, autoDistill: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt, oversized or wrong-schema settings pause automatic activity and are not silently overwritten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-bad-preferences-'));
  try {
    const file = join(dir, 'settings.json');
    for (const text of ['not JSON', '{"recall":"false"}', '{"unknown":true}', '[]', ' '.repeat(4097)]) {
      writeFileSync(file, text);
      const settings = settingsOf({ EVOLVER_RECALL: 'on' }, file);
      assert.equal(settings.recall, false);
      assert.equal(settings.autoDistill, false);
      await assert.rejects(settings.configure({ recall: true }), /invalid or unreadable/);
      assert.equal(readFileSync(file, 'utf8'), text);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a held preference lock refuses an update instead of writing without exclusivity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-locked-preferences-'));
  try {
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{"autoDistill":false}');
    mkdirSync(`${file}.lock`);
    await assert.rejects(settingsOf({}, file).configure({ recall: false }), /Another preference update/);
    assert.equal(readFileSync(file, 'utf8'), '{"autoDistill":false}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

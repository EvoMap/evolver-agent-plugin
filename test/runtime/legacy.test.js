import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { fileStoresOf } from '../../lib/runtime/store/file-stores.js';

const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-legacy-'));
  dirs.push(dir);
  return dir;
}
const write = (dir, name, value) => writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));

test('an old plugin\'s turn counters, open injections and retention checks are adopted once', async () => {
  const dir = folder();
  write(dir, 'opencode-turns.json', { ses_a: { turn: 7, atMs: 1 } });
  write(dir, 'opencode-injected-0123456789abcdef.json', {
    'sha256:open': { turn: 7, injectedAt: 5, strategyText: '1. a.', sessionId: 'ses_a', pid: 4242 },
    'sha256:done': { turn: 6, injectedAt: 4, strategyText: '1. b.', sessionId: 'ses_a', pid: 4242, reportedAt: 6 },
  });
  write(dir, 'opencode-retention-pending.json', [{ sessionId: 'ses_a', projectDir: '/p', reuses: [], files: [], atMs: Date.now() }]);
  const stores = fileStoresOf({ dir, agent: 'opencode' });
  const legacy = [{ ledgers: /^opencode-injected-[0-9a-f]{16}\.json$/ }, { turns: 'opencode-turns.json' }, { retention: 'opencode-retention-pending.json' }];
  stores.adoptLegacy(legacy);
  const session = await stores.sessions.read('ses_a');
  assert.equal(session.turn, 7);
  assert.equal(session.pid, 4242);
  assert.deepEqual(Object.keys(session.injected), ['sha256:open']);
  assert.equal((await stores.retention.takeDue({ sessionId: 'ses_b', projectDir: '/p' })).due.length, 1);
  for (const name of ['opencode-turns.json', 'opencode-injected-0123456789abcdef.json', 'opencode-retention-pending.json']) assert.equal(existsSync(join(dir, name)), false, name);
  write(dir, 'opencode-turns.json', { ses_a: { turn: 99 } });
  stores.adoptLegacy(legacy);
  assert.equal((await stores.sessions.read('ses_a')).turn, 7, 'adopted once');
});

test('files an old plugin named without the agent are moved under its name, and never over a newer one', async () => {
  const dir = folder();
  write(dir, 'session-0123456789abcdef.json', { turn: 3 });
  write(dir, 'reports-outbox.json', { k: { queuedAt: 1 } });
  write(dir, 'workbuddy-reports-outbox.json', { newer: { queuedAt: 2 } });
  mkdirSync(join(dir, 'engine'));
  const stores = fileStoresOf({ dir, agent: 'workbuddy' });
  stores.adoptLegacy([{ rename: /^(?:session-[0-9a-f]{16}\.json|reports-outbox\.json|engine)$/ }]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'workbuddy-session-0123456789abcdef.json'), 'utf8')), { turn: 3 });
  assert.ok(existsSync(join(dir, 'workbuddy-engine')));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'workbuddy-reports-outbox.json'), 'utf8'))), ['newer']);
});

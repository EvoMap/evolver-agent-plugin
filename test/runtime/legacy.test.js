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
  assert.equal(session.injected['sha256:open'].adopted, true);
  assert.equal(session.injected['sha256:done'].reportedAt, 6, 'a reported entry is kept, so the strategy is not handed over again');
  assert.equal((await stores.retention.takeDue({ sessionId: 'ses_b', projectDir: '/p' })).due.length, 1);
  for (const name of ['opencode-turns.json', 'opencode-injected-0123456789abcdef.json', 'opencode-retention-pending.json']) assert.equal(existsSync(join(dir, name)), false, name);
  write(dir, 'opencode-turns.json', { ses_a: { turn: 99 } });
  stores.adoptLegacy(legacy);
  assert.equal((await stores.sessions.read('ses_a')).turn, 7, 'adopted once');
});

test('a ledger alone says how far its session got: the turn counts on from its latest entry, reported or not', async () => {
  const dir = folder();
  write(dir, 'claude-code-injected-0123456789abcdef.json', {
    'sha256:old': { turn: 5, injectedAt: 4, strategyText: '1. a.', sessionId: 'resumed', pid: 4242, reportedAt: 6 },
    'sha256:older': { turn: 2, injectedAt: 1, strategyText: '1. b.', sessionId: 'resumed', pid: 4242, reportedAt: 3 },
  });
  const stores = fileStoresOf({ dir, agent: 'claude-code' });
  stores.adoptLegacy([{ ledgers: /^claude-code-injected-[0-9a-f]{16}\.json$/ }]);
  assert.equal((await stores.sessions.read('resumed')).turn, 5);
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

test('a leftover that fails to move is tried again later, and the folder is not marked done meanwhile', async () => {
  const dir = folder();
  write(dir, 'reports-outbox.json', { k: { queuedAt: 1 } });
  const stores = fileStoresOf({ dir, agent: 'workbuddy' });
  const failing = [{ rename: /^reports-outbox\.json$/ }, { turns: 'missing.json' }, { rename: /^nothing$/ }];
  const originalRename = (await import('node:fs')).default.renameSync;
  const fs = (await import('node:fs')).default;
  fs.renameSync = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  try {
    stores.adoptLegacy(failing);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(existsSync(join(dir, 'workbuddy-legacy-adopted.json')), false);
  stores.adoptLegacy(failing);
  assert.equal(existsSync(join(dir, 'workbuddy-reports-outbox.json')), true);
  assert.equal(existsSync(join(dir, 'workbuddy-legacy-adopted.json')), true);
});

test('WorkBuddy 0.3.0 session files take their id and owner from their ledger entries', async () => {
  const dir = folder();
  write(dir, 'session-0123456789abcdef.json', {
    turn: 4,
    injected: { 'sha256:x': { turn: 4, injectedAt: 1, strategyText: '1. a.', sessionId: 'wb-1', pid: 999_999 } },
  });
  const stores = fileStoresOf({ dir, agent: 'workbuddy' });
  stores.adoptLegacy([{ sessions: /^session-[0-9a-f]{16}\.json$/ }]);
  const adopted = JSON.parse(readFileSync(join(dir, 'workbuddy-session-0123456789abcdef.json'), 'utf8'));
  assert.deepEqual([adopted.sessionId, adopted.pid, adopted.turn, adopted.injected['sha256:x'].adopted], ['wb-1', 999_999, 4, true]);
  assert.equal(existsSync(join(dir, 'session-0123456789abcdef.json')), false);
});

// A folder under a plain file can never be made, whoever runs the test; Node 22's recursive mkdir loops for good
// on a missing folder under /proc.
test('a state folder that cannot be written does not stop the hook', () => {
  const blocker = join(folder(), 'a-file');
  writeFileSync(blocker, '');
  const stores = fileStoresOf({ dir: join(blocker, 'state'), agent: 'workbuddy' });
  assert.doesNotThrow(() => stores.adoptLegacy([{ turns: 'x.json' }]));
});

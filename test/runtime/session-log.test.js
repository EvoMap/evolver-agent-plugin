import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { recordReaderOf } from '../../lib/runtime/records.js';

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'evolver-session-log-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const home = join(root, 'home'); mkdirSync(home);
  writeFileSync(join(home, 'workspaces.json'), JSON.stringify({ workspaces: { workspace: { root: project } } }));
  const agent = join(home, 'sessions/workspace/session/agents/main'); mkdirSync(agent, { recursive: true });
  const wire = join(agent, 'wire.jsonl');
  const decoded = [];
  const declaration = {
    root: () => home, workspaceIndex: 'workspaces.json', logFile: 'agents/main/wire.jsonl',
    nativeSessionOf: (sessionId, scope) => sessionId.startsWith(`${scope}:`) ? sessionId.slice(65) : null,
    workspacesOf: (index) => Object.entries(index.workspaces).map(([id, { root }]) => [id, root]),
    sessionDir: (workspaceId, sessionId) => join('sessions', workspaceId, sessionId),
    decode: (records, context) => {
      decoded.push({ records, context });
      return { status: 'completed', records };
    },
    ...overrides,
  };
  const reader = recordReaderOf(declaration, {});
  return { home, project, agent, wire, decoded, declaration, reader, sessionId: `${reader.scope}:session` };
}

const line = (value) => `${JSON.stringify(value)}\n`;

test('a session log row decodes the whole lines of the session found through the workspace index', (t) => {
  const f = fixture(t);
  writeFileSync(f.wire, line({ type: 'metadata' }) + line({ type: 'turn.prompt', turnId: 0 }) + '{"type":"turn.ended"');
  const row = f.reader(f.sessionId, '0');
  assert.equal(row.status, 'completed');
  assert.deepEqual(row.records.map((record) => record.type), ['metadata', 'turn.prompt']);
  assert.equal(row.records[1].$offset, line({ type: 'metadata' }).length);
  assert.deepEqual(f.decoded[0].context, { turnId: '0', tasks: [], projectDir: f.project });
});

test('a long log is read as its head and tail, and an unchanged log is parsed once', (t) => {
  const f = fixture(t);
  writeFileSync(f.wire, line({ type: 'metadata' }) + line({ filler: 'x'.repeat(5 * 1024 * 1024) }) + line({ type: 'turn.prompt' }));
  const { records } = f.reader(f.sessionId, '1');
  assert.deepEqual(records.map((record) => record.type), ['metadata', 'turn.prompt']);
  assert.equal(f.reader(f.sessionId, '2').records, records);
  appendFileSync(f.wire, line({ type: 'turn.ended' }));
  assert.equal(f.reader(f.sessionId, '1').records.at(-1).type, 'turn.ended');
});

test('a session of another log home, an unsafe id or a missing session has no row', (t) => {
  const f = fixture(t);
  writeFileSync(f.wire, line({}));
  assert.equal(f.reader(`${'0'.repeat(64)}:session`, '0'), null);
  assert.equal(f.reader(`${f.reader.scope}:../session`, '0'), null);
  assert.equal(f.reader(`${f.reader.scope}:other`, '0'), null);
  assert.equal(f.reader(f.sessionId, null), null);
});

test('invalid, oversized, linked or ambiguous files never become an empty valid row', (t) => {
  const f = fixture(t);
  writeFileSync(f.wire, '{invalid}\n');
  assert.equal(f.reader(f.sessionId, '0'), null);
  writeFileSync(f.wire, line({}));
  writeFileSync(join(f.home, 'workspaces.json'), ' '.repeat(1024 * 1024 + 1));
  assert.equal(f.reader(f.sessionId, '0'), null);
  const twin = join(f.home, 'sessions/twin/session/agents/main');
  mkdirSync(twin, { recursive: true });
  writeFileSync(join(twin, 'wire.jsonl'), line({}));
  writeFileSync(join(f.home, 'workspaces.json'), JSON.stringify({ workspaces: { workspace: { root: f.project }, twin: { root: f.project } } }));
  assert.equal(f.reader(f.sessionId, '0'), null);
  rmSync(join(f.home, 'sessions/twin'), { recursive: true });
  const foreign = join(f.project, 'foreign'); mkdirSync(foreign);
  writeFileSync(join(foreign, 'wire.jsonl'), line({}));
  rmSync(f.agent, { recursive: true });
  symlinkSync(foreign, f.agent, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(f.home, 'workspaces.json'), JSON.stringify({ workspaces: { workspace: { root: f.project } } }));
  assert.equal(f.reader(f.sessionId, '0'), null);
});

test('task files the log names are read by id, and a mismatched identity spoils the row', (t) => {
  const f = fixture(t, { taskIds: () => ['task'], tasksDir: (dir) => join(dir, 'agents', 'main', 'tasks') });
  writeFileSync(f.wire, line({}));
  mkdirSync(join(f.agent, 'tasks'));
  writeFileSync(join(f.agent, 'tasks', 'task.json'), JSON.stringify({ taskId: 'task', status: 'running' }));
  assert.ok(f.reader(f.sessionId, '0'));
  assert.deepEqual(f.decoded.at(-1).context.tasks, [{ taskId: 'task', status: 'running' }]);
  writeFileSync(join(f.agent, 'tasks', 'task.json'), JSON.stringify({ taskId: 'task', status: 'completed' }));
  f.reader(f.sessionId, '0');
  assert.deepEqual(f.decoded.at(-1).context.tasks, [{ taskId: 'task', status: 'completed' }], 'a task settling without a log write is seen');
  writeFileSync(join(f.agent, 'tasks', 'task.json'), JSON.stringify({ taskId: 'wrong' }));
  assert.equal(f.reader(f.sessionId, '0'), null);
});

test('a tail window that opens on a line start keeps that line, and a header crossing it comes from the head', (t) => {
  const f = fixture(t);
  const tailBytes = 4 * 1024 * 1024;
  const header = line({ type: 'metadata' });
  const exact = line({ type: 'turn.prompt' });
  const rest = line({ b: 'w'.repeat(tailBytes - exact.length - '{"b":""}\n'.length) });
  assert.equal(Buffer.byteLength(exact + rest), tailBytes);
  writeFileSync(f.wire, header + line({ before: 'z'.repeat(100 * 1024) }) + exact + rest);
  assert.deepEqual(f.reader(f.sessionId, '0').records.map((record) => record.type).filter(Boolean), ['metadata', 'turn.prompt']);
  const crossing = line({ type: 'metadata', padding: 'h'.repeat(200) });
  writeFileSync(f.wire, crossing + line({ b: 'w'.repeat(tailBytes - 50) }));
  const records = f.reader(f.sessionId, '1').records;
  assert.equal(records[0].type, 'metadata', 'a header the tail window cuts is read from the head');
});

test('a log home that moves after the reader started is not read under the old home\'s scope', (t) => {
  const f = fixture(t);
  writeFileSync(f.wire, line({}));
  let home = f.home;
  const other = `${f.home}-other`;
  const reader = recordReaderOf({ ...f.declaration, root: () => home }, {});
  const sessionId = `${reader.scope}:session`;
  assert.ok(reader(sessionId, '0'));
  mkdirSync(join(other, 'sessions/workspace/session/agents/main'), { recursive: true });
  writeFileSync(join(other, 'workspaces.json'), JSON.stringify({ workspaces: { workspace: { root: f.project } } }));
  writeFileSync(join(other, 'sessions/workspace/session/agents/main/wire.jsonl'), line({}));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  home = other;
  assert.equal(reader(sessionId, '0'), null);
});

test('a task the log names many times counts once toward the task limit', (t) => {
  const f = fixture(t, { taskIds: () => Array(100).fill('task'), tasksDir: (dir) => join(dir, 'agents', 'main', 'tasks') });
  writeFileSync(f.wire, line({}));
  mkdirSync(join(f.agent, 'tasks'));
  writeFileSync(join(f.agent, 'tasks', 'task.json'), JSON.stringify({ taskId: 'task', status: 'running' }));
  assert.ok(f.reader(f.sessionId, '0'));
  assert.deepEqual(f.decoded.at(-1).context.tasks, [{ taskId: 'task', status: 'running' }]);
});

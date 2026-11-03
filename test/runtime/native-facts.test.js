import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { nativeFactsOf } from '../../lib/runtime/native-facts.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'evolver-native-facts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'); mkdirSync(project);
  const home = join(root, 'home'); mkdirSync(home);
  writeFileSync(join(home, 'workspaces.json'), JSON.stringify({ version: 1, workspaces: { workspace: { root: project } } }));
  const agent = join(home, 'sessions/workspace/session/agents/main'); mkdirSync(agent, { recursive: true });
  const wire = join(agent, 'wire.jsonl');
  const declaration = { root: () => home, workspaceIndex: 'workspaces.json', sessionId: p => p.session_id,
    projectDir: p => p.cwd, agent: 'main', decode: (records, tasks, payload, context) => ({ records, tasks, context }) };
  return { home, project, wire, declaration, payload: { session_id: 'session', cwd: project } };
}

test('native facts read complete JSONL records under the selected workspace and leave an incomplete tail for the next read', t => {
  const f = fixture(t);
  const first = JSON.stringify({ type: 'metadata', protocol_version: '1.5' }) + '\n';
  writeFileSync(f.wire, first + '{"type":"turn.prompt"');
  const port = nativeFactsOf(f.declaration, {});
  const read = port.read(f.payload);
  assert.equal(read.status, 'partial');
  assert.equal(read.records.length, 1);
  assert.equal(read.records[0].$offset, 0);
  assert.equal(read.mark.offset, Buffer.byteLength(first));
  writeFileSync(f.wire, first + '{"type":"turn.prompt","turnId":0}\n');
  const next = port.read(f.payload, { after: read.mark, schemaVersion: '1.5' });
  assert.equal(next.records[0].type, 'turn.prompt');
  assert.equal(next.records[0].$offset, Buffer.byteLength(first));
  assert.equal(next.context.schemaVersion, '1.5');
});

test('native decoder rejection and mismatched task filename identities are never promoted to valid facts', t => {
  const f = fixture(t);
  writeFileSync(f.wire, '{}\n');
  f.declaration.decode = () => ({ status: 'unsupported' });
  assert.equal(nativeFactsOf(f.declaration).read(f.payload).status, 'unsupported');
  f.declaration.taskIds = () => ['task'];
  f.declaration.tasksRoot = () => join(f.wire, '..', 'tasks');
  mkdirSync(f.declaration.tasksRoot(), { recursive: true });
  writeFileSync(join(f.declaration.tasksRoot(), 'task.json'), JSON.stringify({ taskId: 'wrong' }));
  assert.equal(nativeFactsOf(f.declaration).read(f.payload).status, 'partial');
});

test('missing, invalid, oversized and replaced native files cannot become an empty valid record', t => {
  const f = fixture(t), port = nativeFactsOf(f.declaration, {});
  assert.equal(port.read(f.payload).status, 'missing');
  writeFileSync(f.wire, '{invalid}\n');
  assert.equal(port.read(f.payload).status, 'unreadable');
  writeFileSync(f.wire, '{}\n');
  const mark = port.read(f.payload).mark;
  renameSync(f.wire, `${f.wire}.old`);
  writeFileSync(f.wire, '{}\n');
  assert.equal(port.read(f.payload, { after: mark }).status, 'partial');
  writeFileSync(f.wire, 'x'.repeat(4 * 1024 * 1024));
  assert.equal(port.read(f.payload).status, 'partial');
  writeFileSync(join(f.home, 'workspaces.json'), ' '.repeat(1024 * 1024 + 1));
  assert.equal(port.read(f.payload).status, 'partial');
});

test('native facts refuse path traversal, duplicate workspace mappings and linked files outside home', t => {
  const f = fixture(t), port = nativeFactsOf(f.declaration, {});
  writeFileSync(f.wire, '{}\n');
  assert.equal(port.read({ ...f.payload, session_id: '../session' }).status, 'unsupported');
  writeFileSync(join(f.home, 'workspaces.json'), JSON.stringify({ version: 1, workspaces: { a: { root: f.project }, b: { root: f.project } } }));
  assert.equal(port.read(f.payload).status, 'missing');
  const foreign = join(f.project, 'foreign'); mkdirSync(foreign);
  writeFileSync(join(foreign, 'wire.jsonl'), '{}\n');
  const agent = join(f.wire, '..');
  rmSync(agent, { recursive: true });
  symlinkSync(foreign, agent, process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(f.home, 'workspaces.json'), JSON.stringify({ version: 1, workspaces: { workspace: { root: f.project } } }));
  assert.equal(port.read(f.payload).status, 'unreadable');
});

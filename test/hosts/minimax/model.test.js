import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import profile from '../../../hosts/minimax/profile.js';
import { modelArguments, sessionModelOf } from '../../../hosts/minimax/model.js';
import { recordReaderOf } from '../../../lib/runtime/records.js';

test('the v2 read-only projection captures a session route and variant, independently of later defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'evolver-native-model-'));
  const env = { MINIMAX_DATA_DIR: root };
  const file = profile.modelRecord.file(env); mkdirSync(join(root, 'v2/sqlite'), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, extra_data_json TEXT); CREATE TABLE local_runtime_session_agent_definitions (session_id TEXT PRIMARY KEY, definition_json TEXT)');
    db.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?)').run('session-1', JSON.stringify({ effectiveModel: 'custom_provider:one/model-a', effectiveModelVariant: 'thinking', unrelatedSecret: 'synthetic-private' }));
    const context = { modelRecord: recordReaderOf(profile.modelRecord, env) };
    const captured = sessionModelOf({ session_id: 'session-1', model: 'model-a' }, context);
    assert.deepEqual(captured, { model: 'custom_provider:one/model-a#thinking' });
    db.prepare('UPDATE local_runtime_sessions SET extra_data_json = ?').run(JSON.stringify({ effectiveModel: 'custom_provider:two/model-b' }));
    assert.deepEqual(modelArguments(captured), ['--model', 'custom_provider:one/model-a#thinking']);
    assert.deepEqual(sessionModelOf({ session_id: 'session-1', model: 'model-a' }, context), { model: 'unresolved' });
    assert.deepEqual(sessionModelOf({ session_id: "x' OR 1=1 --", model: 'model-b' }, context), { model: 'unresolved' });
    db.prepare('INSERT INTO local_runtime_session_agent_definitions VALUES (?, ?)').run('session-1', JSON.stringify({ model: { providerId: 'custom_provider:three', modelId: 'model-c', variant: 'high' } }));
    assert.deepEqual(sessionModelOf({ session_id: 'session-1', model: 'model-c' }, context), { model: 'custom_provider:three/model-c#high' });
    db.prepare('UPDATE local_runtime_sessions SET extra_data_json = ?').run(JSON.stringify({ effectiveModel: 'old/model', effectiveModelVariant: 'thinking' }));
    db.prepare('UPDATE local_runtime_session_agent_definitions SET definition_json = ?').run(JSON.stringify({ model: { providerId: 'custom_provider:three', modelId: 'model-c' } }));
    assert.deepEqual(sessionModelOf({ session_id: 'session-1', model: 'model-c' }, context), { model: 'custom_provider:three/model-c' }, 'an absent variant in the authoritative definition cannot inherit a different model’s stale variant');
    const denied = recordReaderOf({ ...profile.modelRecord, query: 'DELETE FROM local_runtime_sessions WHERE session_id = ?' }, env);
    assert.equal(denied('session-1'), null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM local_runtime_sessions').get().n, 1);
    assert.equal(JSON.stringify(context.modelRecord('session-1')).includes('synthetic-private'), false);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('native empty variants preserve the provider route in session metadata and agent definitions', () => {
  const root = mkdtempSync(join(tmpdir(), 'evolver-native-variant-'));
  const env = { MINIMAX_DATA_DIR: root };
  mkdirSync(join(root, 'v2/sqlite'), { recursive: true });
  const db = new DatabaseSync(profile.modelRecord.file(env));
  try {
    db.exec('CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, extra_data_json TEXT); CREATE TABLE local_runtime_session_agent_definitions (session_id TEXT PRIMARY KEY, definition_json TEXT)');
    db.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?)').run('native-session', '{}');
    const context = { modelRecord: recordReaderOf(profile.modelRecord, env) };
    for (const definition of [false, true]) {
      for (const [variant, expected] of [
        ['', 'custom_provider:audit/model-a'],
        [null, 'custom_provider:audit/model-a'],
        [undefined, 'custom_provider:audit/model-a'],
        ['high', 'custom_provider:audit/model-a#high'],
        [' ', 'unresolved'], [';exit', 'unresolved'], [0, 'unresolved'], [false, 'unresolved'],
      ]) {
        const model = { providerId: 'custom_provider:audit', modelId: 'model-a', variant };
        db.prepare('UPDATE local_runtime_sessions SET extra_data_json = ?').run(JSON.stringify(definition
          ? { effectiveModel: 'stale/model', effectiveModelVariant: 'thinking' }
          : { effectiveModel: 'custom_provider:audit/model-a', effectiveModelVariant: variant }));
        if (definition) db.prepare('INSERT OR REPLACE INTO local_runtime_session_agent_definitions VALUES (?, ?)').run('native-session', JSON.stringify({ model }));
        const captured = profile.payload.model({ session_id: 'native-session', model: 'model-a' }, context);
        assert.deepEqual(captured, { model: expected }, `${definition ? 'definition' : 'session'} variant ${JSON.stringify(variant)}`);
        if (expected !== 'unresolved') {
          assert.deepEqual(modelArguments(captured), ['--model', expected]);
          assert.deepEqual(profile.payload.model({ session_id: 'native-session', model: 'different-model' }, context), { model: 'unresolved' });
        } else assert.throws(() => modelArguments(captured), /no completion/);
      }
    }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('unknown schemas, mismatched models and shell-shaped routes never select a fallback provider', () => {
  for (const row of [null, { route: 'only-a-model' }, { route: 'provider/model', variant: ';exit' }, { route: 'provider/model;whoami' }]) {
    assert.deepEqual(sessionModelOf({ session_id: 's' }, { modelRecord: () => row }), { model: 'unresolved' });
  }
  for (const model of ['unresolved', 'model-only', 'provider/model;whoami', 'provider/model#x#y']) assert.throws(() => modelArguments({ model }), /no completion/);
  assert.deepEqual(modelArguments({ model: 'native-default' }), []);
  assert.equal(recordReaderOf({ file: () => join(tmpdir(), 'absent-evolver-native-db'), query: 'SELECT 1' }, {})('s'), null);
});

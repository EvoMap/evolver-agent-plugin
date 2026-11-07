import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { distillSession } from '../../lib/app/distill-session.js';
import { promptSubmitted } from '../../lib/app/prompt.js';
import { toolFinished } from '../../lib/app/tool-result.js';
import { turnEnded } from '../../lib/app/turn-end.js';
import { modelRunnerOf } from '../../lib/runtime/model-executor.js';
import { declarationFor } from '../fixtures/acp/declaration.mjs';
import { memoryPorts, PROMPT } from './memory-ports.js';
import { IR } from './work-turns.js';

const KEY = 'fixture-private-api-key-NOT-A-REAL-CREDENTIAL';
const DRAFT = { ok: true, status: 'draft', publishable: false, distill_id: 'd'.repeat(16), quality: { ok: true, score: 6, threshold: 5 }, signals: ['retry'], gene: { type: 'Gene', asset_id: `sha256:${'a'.repeat(64)}`, summary: IR.capability_summary }, capsule: { type: 'Capsule', asset_id: `sha256:${'b'.repeat(64)}`, summary: IR.capability_summary } };

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-native-distill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.toml'), receipt = join(dir, 'receipt.json');
  writeFileSync(config, '[provider]\nendpoint="https://example.invalid/v1"\nkey_env="FIXTURE_ACCOUNT_KEY"\n');
  const declaration = declarationFor(config, receipt);
  const prepare = declaration.prepare;
  declaration.prepare = (selected, context) => {
    const prepared = prepare(selected, context), entry = prepared.files['fixture.json'];
    entry.value = { ...entry.value, answer: JSON.stringify(IR) };
    return prepared;
  };
  const env = { ...process.env, FIXTURE_ACCOUNT_KEY: KEY };
  const runner = modelRunnerOf(declaration, env);
  const snapshot = runner.capture({ alias: 'route-a', effort: 'off' });
  const made = memoryPorts({ model: runner, distillAnswer: DRAFT });
  await promptSubmitted(made.ports, { sessionId: 'session', prompt: PROMPT, waitMs: 500 });
  await toolFinished(made.ports, { sessionId: 'session', note: { kind: 'edit', paths: ['retry.js'] } });
  await toolFinished(made.ports, { sessionId: 'session', note: { kind: 'shell', command: 'npm test', exit: 0 } });
  await turnEnded(made.ports, { sessionId: 'session', reason: 'answer', answer: 'Fixed retry policy.', model: snapshot });
  return { ...made, dir, receipt, env, snapshot };
}

test('a verified session range completes through the ACP fixture and creates a private IR draft', async (t) => {
  const made = await fixture(t);
  const { at, changedAt, turns: [source] } = (await made.ports.candidates.read()).session;
  const outcome = await distillSession(made.ports, { sessionId: 'session' });
  assert.equal(outcome.status, 'drafted', () => JSON.stringify(outcome));
  const posts = made.requests.filter(({ path }) => path === '/conversation/distill');
  assert.equal(posts.length, 1);
  const [post] = posts;
  assert.deepEqual([post.body.ir_version, post.body.ir, post.body.persist, post.body.publish], ['session-gene-ir-v1', IR, true, false]);
  assert.equal(JSON.stringify(post).includes(KEY), false);
  assert.equal(JSON.stringify(post).includes(made.snapshot.binding), false);
  const corpus = JSON.stringify(await made.ports.corpus.read());
  assert.equal(corpus.includes(KEY), false);
  assert.equal(corpus.includes(made.snapshot.binding), false);
  const [draft] = await made.ports.drafts.read();
  assert.equal(draft.title, IR.title);
  assert.deepEqual(draft.sourceRange, { at, changedAt, turns: [{ turn: source.turn, at: source.at, sessionEpoch: source.sessionEpoch }] });
  assert.deepEqual(await made.ports.candidates.read(), {});
  const receipt = JSON.parse(readFileSync(made.receipt, 'utf8'));
  assert.equal(existsSync(receipt.home), false);
  assert.throws(() => process.kill(receipt.pid, 0), { code: 'ESRCH' });
});

test('unavailable account preflight keeps the range without a model request and restoration retries its original binding', async t => {
  const made = await fixture(t);
  made.env.FIXTURE_ACCOUNT_KEY = 'different-fixture-account';
  assert.deepEqual(await distillSession(made.ports, { sessionId: 'session' }), { status: 'blocked', reason: 'route_changed' });
  const candidate = (await made.ports.candidates.read()).session;
  assert.equal(candidate.attempts, 0);
  assert.deepEqual(candidate.model, made.snapshot);
  assert.equal(candidate.claimedBy, null);
  assert.equal(existsSync(made.receipt), false, 'no native process launched on preflight failure');
  assert.equal(made.requests.some(request => request.path === '/conversation/distill'), false);
  assert.deepEqual(await made.ports.drafts.read(), []);
  made.env.FIXTURE_ACCOUNT_KEY = KEY;
  assert.equal((await distillSession(made.ports, { sessionId: 'session' })).status, 'drafted');
  assert.equal(made.requests.filter(request => request.path === '/conversation/distill').length, 1);
  assert.equal((await made.ports.drafts.read()).length, 1);
  assert.deepEqual(await made.ports.candidates.read(), {});
});

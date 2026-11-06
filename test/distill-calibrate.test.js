import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { distillDue } from '../lib/app/distill-session.js';
import { sessionEnded } from '../lib/app/session-end.js';
import { memoryPorts } from './app/memory-ports.js';
import { changeTurn, fixTurn, modelAnswering, IR } from './app/work-turns.js';
import { fakeProxy } from './helpers/fake-proxy.js';

const SCRIPT = fileURLToPath(new URL('../scripts/distill-calibrate.mjs', import.meta.url));
const MODEL = fileURLToPath(new URL('./fixtures/calibrate-model.mjs', import.meta.url));

async function corpusOf(sessions) {
  const made = memoryPorts({ model: modelAnswering({ skip: 'not now' }) });
  for (const [sessionId, work] of sessions) {
    await work(made.ports, sessionId);
    await sessionEnded(made.ports, { sessionId, projectDir: '/proj' });
  }
  await distillDue(made.ports);
  return made.ports.corpus.read();
}

test('the calibration runner gates the corpus the plugin kept, asks the model, has the Proxy judge each IR without keeping it, and reports', async (t) => {
  const refused = { ok: true, status: 'draft', quality: { ok: false, reason: 'too_project_specific', terms: ['invoiceTotal'] } };
  const proxy = await fakeProxy({ distillAnswer: refused });
  const dir = mkdtempSync(join(tmpdir(), 'evolver-calibrate-'));
  t.after(() => {
    proxy.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const corpus = join(dir, 'corpus.json');
  const token = ['sk-live-', 'Ab3dEf7Gh9Jk2Lm5Np8Qr1St'].join('');
  const kept = await corpusOf([['fixed', fixTurn], ['small', changeTurn]]);
  kept[0].turns[0].prompt += ` API_TOKEN=${token}`;
  writeFileSync(corpus, JSON.stringify(kept));
  const { stdout } = await promisify(execFile)(process.execPath, [SCRIPT, corpus, '--model', `API_TOKEN=${token} "${process.execPath}" "${MODEL}"`], { env: proxy.env });
  assert.ok(!stdout.includes(token), 'the report does not repeat a credential written into the model command');
  const report = JSON.parse(stdout);
  assert.deepEqual([report.prompt_version, report.entries, report.gate], ['session-gene-ir-v1', 2, { passed: 1, pass_rate: 0.5, below: { too_little_work: 1 } }]);
  assert.deepEqual([report.model_answers, report.irs, report.outcomes, report.rejection_reasons], [{ answered: 1 }, 1, { rejected: 1 }, { too_project_specific: 1 }]);
  assert.deepEqual(report.per_ir, [{
    session_id: 'testagent:fixed', status: 'rejected', title: IR.title, by: 'proxy', reason: 'too_project_specific', terms: ['invoiceTotal'],
    kind: 'fix', refs_per_rule: 1, failure_repairs: 1, unknowns: 0, contracts: 0, project_notes: 0,
  }]);
  const [{ body }] = proxy.requests.filter((request) => request.path === '/conversation/distill');
  assert.deepEqual([body.persist, body.publish, body.ir_version, body.session_id], [false, false, 'session-gene-ir-v1', 'testagent:fixed']);
  assert.ok(!JSON.stringify(body).includes(token), 'a turn kept before a redaction rule existed is redacted again as it is replayed');
});

test('the calibration runner refuses a limit that is not a count of entries before it reads the corpus', async () => {
  for (const limit of ['0', '-1', '1.5', 'all']) {
    const run = promisify(execFile)(process.execPath, [SCRIPT, 'missing-corpus.json', `--limit=${limit}`]);
    await assert.rejects(run, (error) => error.code === 1 && error.stderr.includes(`--limit takes a whole number of entries, 1 or more, not ${limit}`), limit);
  }
});

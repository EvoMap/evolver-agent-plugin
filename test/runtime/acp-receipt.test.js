import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { modelRunnerOf } from '../../lib/runtime/model-executor.js';
import { capturedModel, COMPLETION_BUDGET_MS, declarationFor } from '../fixtures/acp/declaration.mjs';

test('a transient receipt replacement refusal does not crash the native fixture before its prompt completes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-acp-receipt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.toml'), receipt = join(dir, 'receipt.json'), preload = join(dir, 'replace-busy.mjs');
  writeFileSync(config, '[provider]\nendpoint="https://example.invalid/v1"\nkey="fixture-private-api-key-NOT-A-REAL-CREDENTIAL"\n');
  writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.renameSync;
let receipts = 0;
fs.renameSync = (from, to) => {
  if (to === process.env.FIXTURE_RECEIPT && ++receipts === 2) {
    throw Object.assign(new Error('fixture temporary replacement refusal'), { code: 'EPERM' });
  }
  return rename(from, to);
};
syncBuiltinESMExports();
`);
  const declaration = declarationFor(config, receipt), args = declaration.args;
  declaration.args = () => ['--import', pathToFileURL(preload).href, ...args()];
  const runner = modelRunnerOf(declaration, process.env);
  const result = await runner.complete(capturedModel(runner, { alias: 'route-a' }), 'receipt regression', AbortSignal.timeout(COMPLETION_BUDGET_MS));
  assert.equal(result.answer, 'answer: receipt regression');
  const native = JSON.parse(readFileSync(receipt, 'utf8'));
  assert.equal(native.promptStarted, true);
  assert.equal(existsSync(native.home), false);
  assert.throws(() => process.kill(native.pid, 0));
});

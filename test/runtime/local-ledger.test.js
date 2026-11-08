import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { pack } from '../../scripts/pack.mjs';

const INGESTOR = `export const events={rootEventsPath:()=>join(process.env.HOME,'events.jsonl'),Ingestor:class{constructor({path}){this.path=path}async ingest(event){appendFileSync(this.path,JSON.stringify(event)+'\\n')}}};`;
const STOPS_AFTER_FIRST_WRITE = `export const events={rootEventsPath:()=>join(process.env.HOME,'events.jsonl'),Ingestor:class{constructor({path}){this.path=path}async ingest(event){appendFileSync(this.path,JSON.stringify(event)+'\\n');const marker=join(process.env.HOME,'stopped');if(!existsSync(marker)){writeFileSync(marker,'');process.exit(1)}}}};`;

/** A packed plugin whose own evolver-core is unavailable, beside a global evolver CLI that ships `coreSource`. */
function packedWithCliCore(t, coreSource) {
  const dir = mkdtempSync(join(tmpdir(), 'evolver-ledger-user-'));
  const previous = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'ComSpec', 'FAKE_NPM_ROOT'].map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const plugin = join(dir, 'plugin'), bin = join(dir, 'bin'), global = join(dir, 'global');
  pack('minimax', plugin); mkdirSync(bin);
  // Hide ancestor node_modules too, so this branch never depends on the developer's installed core.
  const unavailable = join(plugin, 'node_modules/@evomap/evolver-core'); mkdirSync(unavailable, { recursive: true });
  writeFileSync(join(unavailable, 'package.json'), '{"name":"@evomap/evolver-core","type":"module","exports":"./index.js"}');
  writeFileSync(join(unavailable, 'index.js'), 'throw new Error("fixture optional core unavailable");');
  const cli = join(global, '@evomap/evolver');
  const core = join(cli, 'node_modules/@evomap/evolver-core'); mkdirSync(core, { recursive: true });
  writeFileSync(join(cli, 'package.json'), '{"name":"@evomap/evolver"}');
  writeFileSync(join(core, 'package.json'), '{"name":"@evomap/evolver-core","type":"module","exports":"./index.js"}');
  writeFileSync(join(core, 'index.js'), `import{appendFileSync,existsSync,writeFileSync}from'node:fs';import{join}from'node:path';${coreSource}`);
  writeFileSync(join(bin, 'npm.cmd'), '@echo off\r\necho %FAKE_NPM_ROOT%\r\n');
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$FAKE_NPM_ROOT"\n'); chmodSync(join(bin, 'npm'), 0o755);
  Object.assign(process.env, { PATH: [bin, dirname(process.execPath)].join(delimiter), HOME: dir, USERPROFILE: dir, FAKE_NPM_ROOT: global });
  delete process.env.ComSpec;
  return { dir, plugin };
}

const recordedEvent = (dir) => JSON.parse(readFileSync(join(dir, 'events.jsonl'), 'utf8'));

test('a packed plugin finds the global CLI ledger with a clean PATH and no custom command shell', async t => {
  const { dir, plugin } = packedWithCliCore(t, INGESTOR);
  const { recordReuseLocally } = await import(pathToFileURL(join(plugin, 'lib/local-ledger.js')).href);
  assert.equal(await recordReuseLocally({ assetId: 'sha256:fixture', outcome: 'success', sessionId: 's1' }, {}), true);
  const event = recordedEvent(dir);
  assert.equal(event.type, 'value.reuse_hit');
  assert.equal(event.payload.assetId, 'sha256:fixture');
});

test('a resident host keeps running while the packed plugin loads a slow evolver-core for its ledger', async t => {
  const { dir, plugin } = packedWithCliCore(t, `{const until=Date.now()+2000;while(Date.now()<until){}}${INGESTOR}`);
  const { threadedLedger } = await import(pathToFileURL(join(plugin, 'lib/runtime/ledger-thread.js')).href);
  const ledger = threadedLedger({});
  let last = Date.now(), longestStall = 0;
  const host = setInterval(() => { longestStall = Math.max(longestStall, Date.now() - last); last = Date.now(); }, 20);
  try {
    assert.equal(await ledger.record({ assetId: 'sha256:fixture', outcome: 'success', sessionId: 's1' }), true);
  } finally {
    clearInterval(host);
  }
  assert.ok(longestStall < 1000, `the host's event loop stalled ${longestStall} ms while a 2 s evolver-core loaded`);
  assert.equal(recordedEvent(dir).payload.assetId, 'sha256:fixture');
});

test('a ledger thread that stops right after its write leaves the record uncertain, never retried, and a new thread serves the next', async t => {
  const { dir, plugin } = packedWithCliCore(t, STOPS_AFTER_FIRST_WRITE);
  const { threadedLedger } = await import(pathToFileURL(join(plugin, 'lib/runtime/ledger-thread.js')).href);
  const { deliverPending } = await import(pathToFileURL(join(plugin, 'lib/reuse.js')).href);
  const { withQueued } = await import(pathToFileURL(join(plugin, 'lib/report-outbox.js')).href);
  const ledger = threadedLedger({});
  const report = { task_id: 'claude-code:s1:1', asset_id: 'sha256:fixture', outcome: 'success', evidence: { tier: 'L1' } };
  const ledgers = { proxyFetch: async () => ({ ok: true, data: { recorded: true } }), recordLocally: (entry) => ledger.record(entry), onRejected: async () => {} };
  const host = setInterval(() => {}, 1000);
  try {
    const once = await deliverPending(ledgers, withQueued({}, [{ report, sessionId: 'claude-code:s1' }], 1), 1);
    const again = await deliverPending(ledgers, once, 2);
    assert.equal(Object.values(again)[0].localUncertainAt, 1);
    assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').length, 1, 'the write the stopped thread made is not repeated');
    assert.equal(await ledger.record({ assetId: 'sha256:other', outcome: 'success', sessionId: 's2' }), true);
  } finally {
    clearInterval(host);
  }
});

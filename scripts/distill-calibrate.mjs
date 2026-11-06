#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// Runs the current gate, prompt and Proxy rules over a calibration corpus (`<state>/<host>-distill-corpus.json`) and
// prints one JSON report, so a change to any of them can be compared with the last on the same sessions:
//
//   node scripts/distill-calibrate.mjs <corpus.json> [--model "<command>"] [--proxy <url>] [--limit <n>]
//
// `--model` reads the prompt on stdin and prints the answer, or `{ "result": "<answer>" }` (default
// `claude -p --output-format json`). Every IR goes to `POST /conversation/distill` with `persist: false`, so the Proxy
// judges it and keeps nothing.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { distillationOf } from '../lib/app/distill-run.js';
import { rangeOfCorpusEntry } from '../lib/distill/corpus.js';
import { IR_VERSION } from '../lib/distill/ir-prompt.js';
import { irProblemOf, irReplyOf } from '../lib/distill/ir.js';
import { distillBodiesOf } from '../lib/distill/request.js';
import { distillResultOf } from '../lib/distill/result.js';
import { withoutSecrets } from '../lib/redact.js';
import { endTree } from '../lib/runtime/process/spawn.js';
import { proxyFetchOf } from '../lib/runtime/proxy.js';

const DEFAULT_MODEL = 'claude -p --output-format json';
const MODEL_TIMEOUT_MS = 300_000;
const PROXY_TIMEOUT_MS = 120_000;

// The model runs in a process group of its own, so a timeout ends whatever the shell started, not the shell alone.
function modelAnswer(command, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, detached: process.platform !== 'win32', env: { ...process.env, EVOLVER_HEADLESS: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      endTree(child.pid);
    }, MODEL_TIMEOUT_MS);
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) return resolve(answerTextOf(stdout));
      return reject(new Error(`${withoutSecrets(command)} ${timedOut ? `timed out after ${MODEL_TIMEOUT_MS / 1000} s` : `exited ${code}`}`));
    });
    child.stdin.end(prompt);
  });
}

function answerTextOf(stdout) {
  try {
    const printed = JSON.parse(stdout);
    return typeof printed?.result === 'string' ? printed.result : stdout;
  } catch {
    return stdout;
  }
}

function proxyOf(url) {
  if (!url) {
    const proxyFetch = proxyFetchOf(process.env);
    return (method, path, body) => proxyFetch(method, path, body, { timeoutMs: PROXY_TIMEOUT_MS });
  }
  return async (method, path, body) => {
    try {
      const response = await fetch(url.replace(/\/+$/, '') + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) });
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : null;
      return response.ok ? { ok: true, data: parsed } : { ok: false, error: `HTTP ${response.status}`, data: parsed };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  };
}

const counted = (counts, key) => ({ ...counts, [key]: (counts[key] ?? 0) + 1 });

function irMetricsOf(ir) {
  const rules = [...(ir.procedure ?? []), ...(ir.failure_repairs ?? []), ...(ir.canonical_contracts ?? [])];
  const refs = rules.reduce((sum, rule) => sum + (Array.isArray(rule.refs) ? rule.refs.length : 0), 0);
  return {
    kind: ir.kind,
    refs_per_rule: rules.length > 0 ? Number((refs / rules.length).toFixed(2)) : 0,
    failure_repairs: ir.failure_repairs?.length ?? 0,
    unknowns: ir.unknowns?.length ?? 0,
    contracts: ir.canonical_contracts?.length ?? 0,
    project_notes: ir.project_notes?.length ?? 0,
  };
}

async function calibratedEntry(entry, { model, proxy }) {
  const distillation = distillationOf(rangeOfCorpusEntry(entry));
  if (!distillation.gate.passed) return { gate: distillation.gate, irs: [] };
  let reply;
  try {
    reply = irReplyOf(await modelAnswer(model, distillation.prompt));
  } catch (error) {
    return { gate: distillation.gate, model: 'failed', error: String(error?.message ?? error), irs: [] };
  }
  if (!reply) return { gate: distillation.gate, model: 'unparsed', irs: [] };
  if (reply.skip || reply.irs.length === 0) return { gate: distillation.gate, model: 'declined', irs: [] };
  const irs = [];
  for (const ir of reply.irs) {
    const problem = irProblemOf(ir, distillation.session.record.length);
    const metrics = irMetricsOf(ir);
    if (problem) {
      irs.push({ title: ir.title, status: 'rejected', by: 'plugin', reason: 'ir_invalid', field: problem, ...metrics });
      continue;
    }
    const [body] = distillBodiesOf({ platform: entry.platform, sessionId: entry.session_id, trigger: entry.trigger, session: distillation.session, irs: [ir], persist: false });
    const { draft, data, ...result } = distillResultOf(await proxy('POST', '/conversation/distill', body), { title: ir.title, sessionId: entry.session_id }, Date.now());
    irs.push({ ...result, ...metrics });
  }
  return { gate: distillation.gate, model: 'answered', irs };
}

function reportOf(corpusPath, model, calibrated) {
  const irs = calibrated.flatMap(({ entry, irs: list }) => list.map((ir) => ({ session_id: entry.session_id, ...ir })));
  const passed = calibrated.filter(({ gate }) => gate.passed).length;
  return {
    corpus: corpusPath,
    prompt_version: IR_VERSION,
    model: withoutSecrets(model),
    entries: calibrated.length,
    gate: { passed, pass_rate: calibrated.length > 0 ? Number((passed / calibrated.length).toFixed(3)) : 0, below: calibrated.filter(({ gate }) => !gate.passed).reduce((counts, { gate }) => counted(counts, gate.reason), {}) },
    model_answers: calibrated.filter(({ model: answer }) => answer).reduce((counts, { model: answer }) => counted(counts, answer), {}),
    irs: irs.length,
    outcomes: irs.reduce((counts, ir) => counted(counts, ir.status), {}),
    rejection_reasons: irs.filter((ir) => ir.status === 'rejected').reduce((counts, ir) => counted(counts, ir.reason), {}),
    per_ir: irs,
  };
}

function limitOf(text) {
  if (text === undefined) return Infinity;
  const limit = Number(text);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit takes a whole number of entries, 1 or more, not ${text}`);
  return limit;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { model: { type: 'string', default: DEFAULT_MODEL }, proxy: { type: 'string' }, limit: { type: 'string' } } });
  const [corpusPath] = positionals;
  if (!corpusPath) throw new Error('Usage: node scripts/distill-calibrate.mjs <corpus.json> [--model "<command>"] [--proxy <url>] [--limit <n>]');
  const limit = limitOf(values.limit);
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const entries = (Array.isArray(corpus) ? corpus : []).slice(-limit);
  const proxy = proxyOf(values.proxy);
  const calibrated = [];
  for (const entry of entries) calibrated.push({ entry, ...(await calibratedEntry(entry, { model: values.model, proxy })) });
  process.stdout.write(`${JSON.stringify(reportOf(corpusPath, values.model, calibrated), null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
});

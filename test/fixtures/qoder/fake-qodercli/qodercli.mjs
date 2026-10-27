// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { appendFileSync, readFileSync } from 'node:fs';

// Prints what Qoder CLI 1.1.79 printed for `-p --output-format json` (print-answer.json), with the Gene asked for
// as its result, or, with FAKE_QODER_SIGNED_OUT=1, what it printed signed out before exiting 1; logs each run with
// its prompt on stdin.

const GENE = { title: 'Retry uploads', summary: 'Retry a flaky upload with backoff.', strategy: '1. Measure. 2. Back off.', signals: ['retry'] };
const fixture = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  appendFileSync(process.env.FAKE_QODER_LOG, `${JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd(), headless: process.env.EVOLVER_HEADLESS ?? null })}\n`);
  if (process.env.FAKE_QODER_SIGNED_OUT === '1') {
    process.stdout.write(fixture('print-not-logged-in.json'));
    process.exitCode = 1;
    return;
  }
  const printed = JSON.parse(fixture('print-answer.json'));
  const usage = { ...printed.usage, input_tokens: 900, output_tokens: 120 };
  process.stdout.write(`${JSON.stringify({ ...printed, result: process.env.FAKE_QODER_ANSWER ?? JSON.stringify(GENE), usage })}\n`);
});

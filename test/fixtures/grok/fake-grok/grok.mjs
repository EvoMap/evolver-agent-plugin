import { appendFileSync, readFileSync } from 'node:fs';

const GENE = { title: 'Retry uploads', summary: 'Retry a flaky upload with backoff.', strategy: '1. Measure. 2. Back off.', signals: ['retry'] };
const ANSWER = JSON.parse(readFileSync(new URL('../print-answer.json', import.meta.url), 'utf8'));

const args = process.argv.slice(2);
const promptFile = args[args.indexOf('--prompt-file') + 1];
const isolation = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^GROK_/.test(name)));
appendFileSync(process.env.FAKE_GROK_LOG, `${JSON.stringify({ args, prompt: readFileSync(promptFile, 'utf8'), cwd: process.cwd(), headless: process.env.EVOLVER_HEADLESS ?? null, isolation })}\n`);
process.stdout.write(`${JSON.stringify({ ...ANSWER, text: JSON.stringify(GENE), cwd: process.cwd() }, null, 2)}\n`);

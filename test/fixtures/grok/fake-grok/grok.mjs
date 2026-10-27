import { appendFileSync, readFileSync } from 'node:fs';

const GENE = { title: 'Retry uploads', summary: 'Retry a flaky upload with backoff.', strategy: '1. Measure. 2. Back off.', signals: ['retry'] };
const ANSWER = JSON.parse(readFileSync(new URL('../print-answer.json', import.meta.url), 'utf8'));

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  appendFileSync(process.env.FAKE_GROK_LOG, `${JSON.stringify({ args: process.argv.slice(2), prompt, cwd: process.cwd(), headless: process.env.EVOLVER_HEADLESS ?? null })}\n`);
  process.stdout.write(`${JSON.stringify({ ...ANSWER, text: JSON.stringify(GENE), cwd: process.cwd() }, null, 2)}\n`);
});

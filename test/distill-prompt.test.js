import assert from 'node:assert/strict';
import { test } from 'node:test';

import { candidateOf } from '../lib/distill/candidate.js';
import { distillBody, distillPrompt } from '../lib/distill/prompt.js';

test('a check run with credentials on its command line goes in the trace without them', () => {
  const checks = [
    { command: 'curl -u sentinel-user:CANARY_SECRET https://internal.example.test', exit: 0, failed: false },
    { command: 'npm test -- --token CANARY_TOKEN_1', exit: 0, failed: false },
    { command: "curl -u 'sentinel-user:CANARY_QUOTED' -H 'Authorization: Bearer CANARY_BEARER' https://internal.example.test", exit: 0, failed: false },
    { command: 'npm test -- --password "CANARY PASS"', exit: 0, failed: false },
    { command: "env PASSWORD='abc CANARY_SPACED' npm test", exit: 0, failed: false },
    { command: `curl -H 'Authorization: Digest username="u", response="CANARY_DIGEST"' -H 'Proxy-Authorization: Basic CANARYb' https://x.test`, exit: 0, failed: false },
  ];
  const candidate = candidateOf({ prompt: 'Fix the client', record: { checks, commands: [], paths: [], answer: 'Fixed.' }, model: null, turn: 1, pid: 1, now: 1, source: 'observed' });
  const body = distillBody({ platform: 'codex', sessionId: 's1', candidate, args: {} });
  assert.doesNotMatch(JSON.stringify(body), /CANARY/);
  assert.deepEqual(body.execution.trace.map(({ command }) => command), ['curl -u [redacted] https://internal.example.test', 'npm test -- --token [redacted]',
    "curl -u [redacted] -H '[redacted]' https://internal.example.test", 'npm test -- --password [redacted]', 'env [redacted] npm test',
    "curl -H '[redacted]' -H '[redacted]' https://x.test"]);
});

test('an earlier unknown check stays unknown in the model record and supplies no fabricated exit code', () => {
  const candidate = {
    prompt: 'Fix the retries', commands: ['npm run lint', 'npm test'], paths: [], answer: 'Fixed.',
    checks: [{ command: 'npm run lint', failed: null }, { command: 'npm test', failed: false }],
  };
  assert.match(distillPrompt(candidate), /- unknown: npm run lint/);
  assert.doesNotMatch(distillPrompt(candidate), /passed: npm run lint/);
  const body = distillBody({ platform: 'codex', sessionId: 's1', candidate, args: {} });
  assert.deepEqual(body.execution.trace, [{ command: 'npm test', ok: true, source: 'reported' }]);
});

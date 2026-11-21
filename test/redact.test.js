import assert from 'node:assert/strict';
import { test } from 'node:test';

import { irPromptOf } from '../lib/distill/ir-prompt.js';
import { sessionRecordOf } from '../lib/distill/record.js';
import { distillBodiesOf } from '../lib/distill/request.js';
import { workTurnOf } from '../lib/distill/work-turn.js';
import { containsSecret, withoutSecrets } from '../lib/redact.js';
import { isVerificationCommand } from '../lib/verification.js';

test('redaction removes the complete JSON string and leaves unrelated fields', () => {
  const text = JSON.stringify({ API_KEY: 'fixture "quoted" \\ tail', DEPLOY_KEY: 'fixture deploy', token: 'short', topic: 'retry' });
  assert.equal(containsSecret(text), true);
  assert.deepEqual(JSON.parse(withoutSecrets(text)), { API_KEY: '[redacted]', DEPLOY_KEY: '[redacted]', token: '[redacted]', topic: 'retry' });
  assert.equal(containsSecret(withoutSecrets(text)), false);
  assert.equal(withoutSecrets('token=fixtureCredential123456'), '[redacted]');
});

test('camelCase JSON credentials are redacted without removing ordinary keys', () => {
  const ordinary = { primaryKey: 'orders.id', primary_key: 'orders.id', foreignKey: 'customers.id', cacheKey: 'retry-cache', maxTokens: '4096', monkey: 'example' };
  const credentials = { accessToken: 'fixture access', refreshToken: 'fixture "quoted" \\ tail', refresh_token: 'fixture refresh', openaiApiKey: 'fixture key', dbPassword: 'fixture password' };
  assert.equal(containsSecret(JSON.stringify(ordinary)), false);
  const text = JSON.stringify({ ...credentials, ...ordinary });
  assert.equal(containsSecret(text), true);
  const redacted = withoutSecrets(text);
  assert.deepEqual(JSON.parse(redacted), { ...Object.fromEntries(Object.keys(credentials).map((key) => [key, '[redacted]'])), ...ordinary });
  assert.equal(containsSecret(redacted), false);
  assert.equal(withoutSecrets(redacted), redacted);
});

test('JSON credential containers are redacted whole while business key values retain their shape', () => {
  const ordinary = { primaryKey: { columns: ['orders.id'] }, primary_key: ['orders.id'], foreignKey: ['customers.id'], cacheKey: { namespace: 'retry' } };
  for (const key of ['token', 'refreshToken', 'refresh_token', 'API_KEY', 'DEPLOY_KEY', 'openaiApiKey', 'dbPassword']) {
    for (const value of [{ value: 'opaqueFixture123456' }, ['opaqueFixture123456'], { values: [{ value: 'opaqueFixture123456', note: '\\" } ]' }] }, {}, []]) {
      const text = JSON.stringify({ ...ordinary, [key]: value, topic: 'retry' }, null, 2);
      const redacted = withoutSecrets(text);
      assert.equal(containsSecret(text), true, key);
      assert.deepEqual(JSON.parse(redacted), { ...ordinary, [key]: '[redacted]', topic: 'retry' });
      assert.doesNotMatch(redacted, /opaqueFixture/);
      assert.equal(containsSecret(redacted), false);
      assert.equal(withoutSecrets(redacted), redacted);
    }
  }
  assert.equal(withoutSecrets(JSON.stringify(ordinary)), JSON.stringify(ordinary));
});

test('multiline diff credential containers include nested values after added or removed line prefixes', () => {
  for (const marker of ['+', '-']) {
    const text = marker + '"accessToken":\n' + marker + ' {"values": ["opaqueFixture123456", {"value": "opaqueFixture789012"}]}\n' + marker + '"primaryKey": ["orders.id"]';
    const redacted = withoutSecrets(text);
    assert.equal(containsSecret(text), true);
    assert.doesNotMatch(redacted, /opaqueFixture/);
    assert.match(redacted, /"primaryKey": \["orders.id"\]/);
    assert.equal(withoutSecrets(redacted), redacted);
    assert.equal(containsSecret(redacted), false);
  }
});

test('incomplete or mismatched JSON credential values cannot leave trailing secrets', () => {
  for (const value of [
    '{"value":"opaqueFixture123456"',
    '["opaqueFixture123456", {"value":"opaqueFixture789012"}',
    '{"value":"opaqueFixture123456"] opaqueFixture789012',
    '"unfinished\n+ {"value":"opaqueFixture789012"}',
    '"unfinished\\\r\n+ {"value":"opaqueFixture789012"}',
  ]) {
    const text = '{"token":' + value;
    const redacted = withoutSecrets(text);
    assert.equal(containsSecret(text), true);
    assert.doesNotMatch(redacted, /opaqueFixture/);
    assert.deepEqual(JSON.parse(redacted + '}'), { token: '[redacted]' });
    assert.equal(withoutSecrets(redacted), redacted);
  }
});

test('the saved work turn, model prompt and Proxy body exclude JSON credentials', () => {
  const secret = /fixture(?:Credential|Refresh)123456/;
  for (const credentials of [
    { password: 'fixtureCredential123456', refreshToken: 'fixtureRefresh123456' },
    { password: { value: 'fixtureCredential123456' }, refreshToken: ['fixtureRefresh123456'] },
  ]) {
    const detail = JSON.stringify(credentials);
    const record = { answer: 'Retry now works with ' + detail, commands: ['npm test -- ' + detail], edits: [], checks: [{ command: 'npm test -- ' + detail, failed: false }] };
    const turn = workTurnOf({ turn: 1, prompt: 'Fix upload retry with ' + detail, record, answer: record.answer, now: 1 });
    const session = sessionRecordOf({ turns: [turn], source: 'observed' });
    const [body] = distillBodiesOf({ platform: 'test', sessionId: 'test-session', trigger: 'idle', session, irs: [{ title: 'Repair upload retry' }] });
    for (const text of [JSON.stringify(turn), irPromptOf({ record: session.record, kind: 'change', focus: detail }), JSON.stringify(body)]) {
      assert.doesNotMatch(text, secret);
      assert.match(text, /\[redacted\]/);
      assert.match(text, /upload retry/);
    }
  }
});

test('HTTP cookie credentials stay out of the saved work turn and private Proxy body', () => {
  const secret = /opaqueFixture(?:Session|Route)/;
  const headers = { Cookie: 'sid=opaqueFixtureSession; route=opaqueFixtureRoute',
    'set-cookie': ['sid="opaqueFixtureSession"; HttpOnly'], primaryKey: 'orders.id' };
  const json = withoutSecrets(JSON.stringify(headers));
  assert.deepEqual(JSON.parse(json), { Cookie: '[redacted]', 'set-cookie': '[redacted]', primaryKey: 'orders.id' });
  assert.equal(containsSecret(json), false);
  const answer = 'Upload retry passed.\nCookie: ' + headers.Cookie + '\nSet-Cookie: ' + headers['set-cookie'][0] + '\nNo other changes.';
  assert.ok(containsSecret(answer));
  const record = { commands: ['npm test'], edits: [], checks: [{ command: 'npm test', failed: false }] };
  const turn = workTurnOf({ turn: 1, prompt: 'Fix upload retry', record, answer, now: 1 });
  const session = sessionRecordOf({ turns: [turn], source: 'observed' });
  const [body] = distillBodiesOf({ platform: 'copilot', sessionId: 'test-session', trigger: 'idle', session,
    irs: [{ title: 'Repair upload retry' }], persist: false });
  for (const text of [turn.answer, JSON.stringify(body)]) {
    assert.doesNotMatch(text, secret);
    assert.match(text, /\[redacted\]/);
    assert.match(text, /No other changes\./);
  }
  assert.equal(containsSecret(turn.answer), false);
  assert.equal(body.persist, false);
});

test('redacting a quoted Cookie header preserves the following verification command', () => {
  const command = 'curl -H "Cookie: token=opaqueFixtureSession; route=opaqueFixtureRoute" https://example.test && npm test';
  assert.equal(withoutSecrets(command), 'curl -H "[redacted]" https://example.test && npm test');
});

test('redacting Cookie headers leaves no secondary cookie and preserves compact shell arguments', () => {
  assert.equal(withoutSecrets('Cookie: token=opaqueFixtureToken; sid=opaqueFixtureSession\nVerification passed.'), '[redacted]\nVerification passed.');
  for (const flag of ['-H ', '--header=']) {
    const command = `curl ${flag}Cookie:sid=opaqueFixtureSession https://example.test && npm test`;
    assert.equal(withoutSecrets(command), `curl ${flag}[redacted] https://example.test && npm test`);
  }
});

test('Cookie shell arguments keep command boundaries while removing attached-header credentials', () => {
  for (const [command, expected] of [
    ['curl -HCookie:sid=opaqueFixtureSession https://example.test && npm test', 'curl -H[redacted] https://example.test && npm test'],
    ['curl -HCookie:sid=opaqueFixtureSession;route=opaqueFixtureRoute https://example.test && npm test', 'curl -H[redacted] https://example.test && npm test'],
    ['curl -H"Cookie: sid=opaqueFixtureSession; route=opaqueFixtureRoute" https://example.test && npm test', 'curl -H"[redacted]" https://example.test && npm test'],
  ]) {
    assert.equal(containsSecret(command), true, command);
    const redacted = withoutSecrets(command);
    assert.equal(redacted, expected);
    assert.doesNotMatch(redacted, /opaqueFixture/);
    assert.equal(isVerificationCommand(command), true);
    assert.equal(isVerificationCommand(redacted), true, 'the same later verification command must remain attributable');
    assert.equal(containsSecret(redacted), false);
  }
});

test('partially quoted Cookie arguments cannot leave credential suffixes behind', () => {
  for (const command of [
    'curl -HCookie:sid="opaqueFixtureSession" https://example.test && npm test',
    'curl -HCookie:"sid=opaqueFixtureSession; route=opaqueFixtureRoute" https://example.test && npm test',
    'curl -H"Cookie:sid="opaqueFixtureSession https://example.test && npm test',
    'curl -H "Cookie: sid="opaqueFixtureSession https://example.test && npm test',
    'curl "-HCookie:sid=opaqueFixtureSession; route=opaqueFixtureRoute" https://example.test && npm test',
    'curl --header=Cookie:"sid=opaqueFixtureSession; route=opaqueFixtureRoute" https://example.test && npm test',
  ]) {
    const redacted = withoutSecrets(command);
    assert.equal(containsSecret(command), true);
    assert.doesNotMatch(redacted, /opaqueFixture/);
    assert.equal(containsSecret(redacted), false);
    assert.match(redacted, /\[redacted\]$/);
  }
});

test('Cookie redaction retains conservative header privacy and does not promote escaped shell data', () => {
  assert.equal(withoutSecrets('Cookie: sid=opaqueFixtureSession; route=opaqueFixtureRoute && npm test\nNext line.'), '[redacted]\nNext line.');
  assert.equal(withoutSecrets('HTTP debug Cookie: sid=opaqueFixtureSession; route=opaqueFixtureRoute && npm test'), 'HTTP debug [redacted]');
  for (const command of [
    String.raw`curl -HCookie:sid=opaqueFixtureSession\;route=opaqueFixtureRoute https://example.test`,
    String.raw`curl -H Cookie:sid=opaqueFixtureSession\;npm\ test https://example.test`,
    'curl -HCookie:sid=opaqueFixtureSession`x https://example.test && npm test',
    'curl -HCookie:sid=opaqueFixtureSession` x https://example.test && npm test',
    'curl -HCookie:si`d=opaqueFixtureSession https://example.test && npm test',
    "curl -HCookie:si'd=opaqueFixtureSession https://example.test && npm test",
  ]) {
    const redacted = withoutSecrets(command);
    assert.doesNotMatch(redacted, /opaqueFixture/);
    assert.equal(isVerificationCommand(command), false);
    assert.equal(isVerificationCommand(redacted), false);
    assert.equal(containsSecret(redacted), false);
  }
});

test('Cookie shell continuations keep every credential fragment private without promoting verification', () => {
  for (const escape of ['\\', '`', '^']) for (const newline of ['\n', '\r\n']) {
    for (const [head, tail, expected] of [
      ['curl -H "Cookie: sid=opaqueFixtureSession', 'opaqueFixtureTail" https://example.test && npm test', 'curl -H "[redacted]" https://example.test && npm test'],
      ['curl -HCookie:sid=opaqueFixtureSession', 'opaqueFixtureTail https://example.test && npm test', escape === '`' ? 'curl -H[redacted]' : 'curl -H[redacted] https://example.test && npm test'],
      ['curl -HCookie:sid="opaqueFixtureSession', 'opaqueFixtureTail" https://example.test && npm test', 'curl -H[redacted]'],
    ]) {
      const command = head + escape + newline + tail;
      const redacted = withoutSecrets(command);
      assert.equal(redacted, expected, JSON.stringify(command));
      assert.doesNotMatch(redacted, /opaqueFixture/);
      assert.equal(containsSecret(command), true);
      assert.equal(containsSecret(redacted), false);
      if (!isVerificationCommand(command)) assert.equal(isVerificationCommand(redacted), false);
      if (expected.endsWith('&& npm test')) assert.equal(isVerificationCommand(redacted), true);
    }
  }
});

test('multiline quoted and folded HTTP Cookie headers leave later unindented text intact', () => {
  for (const [text, expected] of [
    ['Cookie: sid=opaqueFixtureSession\r\n route=opaqueFixtureRoute\r\nContent-Type: text/plain', '[redacted]\r\nContent-Type: text/plain'],
    ['Cookie: sid=opaqueFixtureSession\n\troute=opaqueFixtureRoute\nNext line.', '[redacted]\nNext line.'],
    ['curl -H "Cookie: sid=opaqueFixtureSession\nroute=opaqueFixtureRoute" https://example.test && npm test', 'curl -H "[redacted]" https://example.test && npm test'],
    ['Cookie:\r\n sid=opaqueFixtureSession; route=opaqueFixtureRoute\r\nNext: value', '[redacted]\r\nNext: value'],
    ['Set-Cookie:\n\tsid=opaqueFixtureSession\nNext: value', '[redacted]\nNext: value'],
  ]) {
    const redacted = withoutSecrets(text);
    assert.equal(redacted, expected);
    assert.doesNotMatch(redacted, /opaqueFixture/);
    assert.equal(containsSecret(text), true);
    assert.equal(containsSecret(redacted), false);
    if (!isVerificationCommand(text)) assert.equal(isVerificationCommand(redacted), false);
  }
  for (const newline of ['\n', '\r\n']) for (const text of [
    'curl -H "Cookie:sid=opaqueFixtureSession' + newline + 'opaqueFixtureTail',
    'curl -HCookie:sid="opaqueFixtureSession' + newline + 'opaqueFixtureTail" https://example.test && npm test',
  ]) {
    const redacted = withoutSecrets(text);
    assert.doesNotMatch(redacted, /opaqueFixture/);
    assert.match(redacted, /\[redacted\]$/);
    assert.equal(containsSecret(text), true);
    assert.equal(containsSecret(redacted), false);
    if (!isVerificationCommand(text)) assert.equal(isVerificationCommand(redacted), false);
  }
  for (const text of ['node --test native.test.js\nNext line.', 'npm test\r\n  Verification passed.', 'A normal paragraph.\n\tContinued prose.']) {
    assert.equal(withoutSecrets(text), text);
    assert.equal(containsSecret(text), false);
  }
});

test('redaction stays linear on long adversarial input', () => {
  const size = 64 * 1024;
  const fill = (head, unit) => head + unit.repeat(Math.ceil(size / unit.length));
  for (const text of [
    fill('', 'a-'),
    fill('_', '1-'),
    fill('.', 'a.'),
    fill('=', '-eyJ'),
    fill('', ' \n'),
    fill('api_key', ' '),
    fill('A_KEY', ' '),
    fill(' -u', ' '),
    fill(' --password', ' '),
    fill('curl -H Cookie:', 'a'),
    fill('curl -H"Cookie:sid=', 'a'),
    fill('Cookie: "', 'a'),
    fill('curl -H "Cookie:sid=', 'a\\\n'),
    fill('curl -HCookie:sid="', 'a`\r\n'),
    fill('Cookie:\r\n ', 'sid=a; \r\n '),
  ]) {
    const started = performance.now();
    withoutSecrets(text);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 100, `${JSON.stringify(text.slice(0, 12))}… took ${elapsed.toFixed(0)} ms`);
  }
});

test('a credential inside a long run is redacted from where the run begins', () => {
  assert.equal(withoutSecrets('--api_key=fixtureSecret123'), '--[redacted]');
  assert.equal(withoutSecrets('__a-api_key=fixtureSecret123'), '__a-[redacted]');
  assert.equal(withoutSecrets('x-y.z-https://user:fixturePass@host'), '[redacted]host');
  assert.equal(withoutSecrets('1.https://user:fixturePass@host'), '1.[redacted]host');
  assert.equal(withoutSecrets('a-eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl'), 'a-[redacted]');
  assert.equal(withoutSecrets('curl -u   user:fixturePass'), 'curl -u   [redacted]');
  assert.equal(withoutSecrets('cli --password   fixturePass'), 'cli --password   [redacted]');
});

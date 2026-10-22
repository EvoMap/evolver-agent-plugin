import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

// Load the actual hook on every supported Node version without adding a compiler.
const stage = mkdtempSync(join(tmpdir(), 'evolver-agent-plugin-hooks-'));
after(() => rmSync(stage, { recursive: true, force: true }));
cpSync(new URL('../lib/', import.meta.url), join(stage, 'lib'), { recursive: true });
mkdirSync(join(stage, 'hooks'));
writeFileSync(join(stage, 'hooks/register.mjs'), stripTypeScriptTypes(readFileSync(new URL('../hooks/register.ts', import.meta.url), 'utf8')));
const { register } = await import(pathToFileURL(join(stage, 'hooks/register.mjs')));

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'evolver-agent-plugin-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'profile 名');
  const otherHome = join(root, 'other-profile');
  const env = {};
  const reads = [];
  const requests = [];
  const toasts = [];
  const stored = new Map();
  const timers = new Set();
  let token = 'fixture-token';
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
    response.writeHead(request.headers.authorization === `Bearer ${token}` ? 200 : 401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ authorized: request.headers.authorization === `Bearer ${token}`, recorded: false }));
  });
  t.after(() => new Promise((done) => server.close(done)));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = String(server.address().port);
  function settings(directory, content = { proxy: { url: `http://127.0.0.1:${port}`, token } }) {
    mkdirSync(join(directory, '.evolver'), { recursive: true });
    writeFileSync(join(directory, '.evolver/settings.json'), typeof content === 'string' ? content : JSON.stringify(content));
  }
  settings(home);
  const handlers = new Map();
  const on = (event, matcher, handler) => {
    handlers.set(handler ? `${event}:${matcher.command}` : event, handler ?? matcher);
    return { catch() {} };
  };
  const engine = {
    env: { get: async (name) => env[name] },
    fs: { read: async (file) => {
      reads.push(file);
      if (!resolve(file).startsWith(root + sep)) throw new Error('Read outside the test profile');
      return readFile(file, 'utf8');
    } },
    http: { fetch: async (url, options) => {
      const response = await fetch(url, options);
      return { ok: response.ok, status: response.status, text: await response.text() };
    } },
    clock: {
      now: async () => Date.now(),
      sleep: (ms) => new Promise((done) => {
        const timer = setTimeout(done, ms);
        timer.unref();
        timers.add(timer);
      }),
    },
    store: { get: async (key) => stored.get(key), set: async (key, value) => stored.set(key, value), delete: async (key) => stored.delete(key) },
    session: { id: async () => 'home-test' },
    command: { register: async () => ({}) },
    ui: { toast: (text) => toasts.push(text) },
    process: { run: async () => { throw new Error('CLI is not installed in this hook fixture'); } },
  };
  t.after(() => timers.forEach(clearTimeout));
  register(on, { proxy_port: port, claim_nudge_enabled: true });
  const call = (event, input = {}) => handlers.get(event)(engine, input, async (value) => value);
  const status = () => call('command.run:evolver-status', { command: 'evolver-status', args: '' });
  const search = (args) => call('command.run:evolver-search', { command: 'evolver-search', args });
  return { home, otherHome, env, reads, requests, toasts, settings, status, search, call, rotate: (value) => { token = value; } };
}

for (const homeValue of [undefined, '']) {
  test(`USERPROFILE supplies the Proxy token when HOME is ${JSON.stringify(homeValue)}`, async (t) => {
    const f = await fixture(t);
    f.env.HOME = homeValue;
    f.env.USERPROFILE = f.home;
    const answer = await f.status();
    assert.doesNotMatch(answer.text, /HTTP 401/);
    assert.equal(f.requests[0].authorization, 'Bearer fixture-token');
    assert.equal(resolve(f.reads[0]), join(f.home, '.evolver/settings.json'));
  });
}

test('HOME keeps precedence over a different USERPROFILE', async (t) => {
  const f = await fixture(t);
  f.env.HOME = f.home;
  f.env.USERPROFILE = f.otherHome;
  f.settings(f.otherHome, { proxy: { token: 'wrong-profile-token' } });
  assert.doesNotMatch((await f.status()).text, /HTTP 401/);
  assert.equal(resolve(f.reads[0]), join(f.home, '.evolver/settings.json'));
});

test('rotated credentials are reread for GET and POST commands', async (t) => {
  const f = await fixture(t);
  f.env.USERPROFILE = f.home;
  assert.doesNotMatch((await f.status()).text, /HTTP 401/);
  f.rotate('rotated-fixture-token');
  f.settings(f.home, { proxy: { token: 'rotated-fixture-token' } });
  const answer = await f.search('retry the flaky uploader with backoff');
  assert.doesNotMatch(answer.text, /HTTP 401/);
  assert.equal(f.requests[1].authorization, 'Bearer rotated-fixture-token');
  assert.equal(f.requests[1].method, 'POST');
  assert.equal(f.requests[1].path, '/asset/fetch');
});

test('missing home variables never read root-directory credentials or claim links', async (t) => {
  const f = await fixture(t);
  assert.match((await f.status()).text, /HTTP 401/);
  await f.call('session.start');
  await f.call('session.end', { sessionId: 'home-test' });
  assert.deepEqual(f.reads, []);
  assert.equal(f.requests[0].authorization, undefined);
  assert.deepEqual(f.toasts, []);
});

test('claim reminders use the same Windows profile fallback', async (t) => {
  const f = await fixture(t);
  f.env.USERPROFILE = f.home;
  mkdirSync(join(f.home, '.evomap'));
  writeFileSync(join(f.home, '.evomap/claim_url'), 'https://evomap.ai/claim/home-test');
  await f.call('session.start');
  await f.call('session.end', { sessionId: 'home-test' });
  assert.equal(resolve(f.reads[0]), join(f.home, '.evomap/claim_url'));
  assert.match(f.toasts[0], /https:\/\/evomap.ai\/claim\/home-test/);
});

for (const settingsText of ['not json', '{}']) {
  test(`unusable settings stay an unauthenticated, actionable 401 (${settingsText})`, async (t) => {
    const f = await fixture(t);
    f.env.USERPROFILE = f.home;
    f.settings(f.home, settingsText);
    const answer = await f.status();
    assert.match(answer.text, /HTTP 401.*No Proxy token was found/);
    assert.equal(f.requests[0].authorization, undefined);
  });
}

test('a missing settings file stays an unauthenticated, actionable 401', async (t) => {
  const f = await fixture(t);
  f.env.USERPROFILE = f.home;
  rmSync(join(f.home, '.evolver/settings.json'));
  const answer = await f.status();
  assert.match(answer.text, /HTTP 401.*No Proxy token was found/);
  assert.equal(f.requests[0].authorization, undefined);
});

test('an invalid token remains rejected rather than bypassing Proxy auth', async (t) => {
  const f = await fixture(t);
  f.env.USERPROFILE = f.home;
  f.settings(f.home, { proxy: { token: 'wrong-fixture-token' } });
  const answer = await f.status();
  assert.match(answer.text, /HTTP 401.*token .* was rejected/);
});

test('a non-loopback settings URL cannot receive the token', async (t) => {
  const f = await fixture(t);
  f.env.USERPROFILE = f.home;
  f.settings(f.home, { proxy: { url: 'https://invalid.example', token: 'fixture-token' } });
  assert.doesNotMatch((await f.status()).text, /HTTP 401/);
  assert.equal(f.requests[0].path, '/proxy/status');
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { headlessKimi } from '../../../hosts/kimi/model.js';
import { modelRunnerOf } from '../../../lib/runtime/model-executor.js';

const ACCESS = 'fixture-coding-access-only';
const REFRESH = 'fixture-refresh-never-copied';
const DEVICE = '01234567-89ab-4def-8123-456789abcdef';
const HINT = { alias: 'kimi-code/k3', effort: 'high' };

function fixture(t) {
  const profile = mkdtempSync(join(tmpdir(), 'evolver-kimi-oauth-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const config = join(profile, 'config.toml'), device = join(profile, 'device_id');
  mkdirSync(join(profile, 'credentials'));
  const tokenFile = join(profile, 'credentials', 'kimi-code.json');
  writeFileSync(config, `default_model = "kimi-code/k3"
[providers."managed:kimi-code"]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = ""
[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
display_name = "Kimi K3"
max_context_size = 65536
capabilities = ["thinking", "always_thinking", "tool_use"]
support_efforts = ["low", "high", "max"]
default_effort = "high"
`);
  const wire = { access_token: ACCESS, refresh_token: REFRESH, token_type: 'Bearer', expires_at: Math.floor(Date.now() / 1000) + 3600 };
  const setToken = (overrides = {}) => writeFileSync(tokenFile, JSON.stringify({ ...wire, ...overrides }));
  setToken();
  writeFileSync(device, DEVICE);
  const starts = [];
  const env = { HOME: profile, USERPROFILE: profile, KIMI_CODE_HOME: profile };
  const runner = modelRunnerOf({ ...headlessKimi, command: () => { starts.push(true); return null; } }, env);
  return { config, device, tokenFile, setToken, starts, runner };
}

test('a current managed Kimi credential binds the exact route without exposing bearer, refresh or device', t => {
  const f = fixture(t), original = readFileSync(f.tokenFile);
  const model = f.runner.capture(HINT);
  assert.deepEqual([model.providerId, model.providerType, model.protocol, model.model, model.effort],
    ['managed:kimi-code', 'kimi', 'openai', 'k3', 'high']);
  for (const privateValue of [ACCESS, REFRESH, DEVICE]) assert.equal(JSON.stringify(model).includes(privateValue), false);
  assert.deepEqual(readFileSync(f.tokenFile), original);
  assert.deepEqual(f.starts, []);
});

test('rotated or expired access credentials and changed device identity block before native launch', async t => {
  const f = fixture(t), model = f.runner.capture(HINT);
  f.setToken({ refresh_token: 'different-unused-refresh' });
  assert.deepEqual(f.runner.capture(HINT), model, 'an unused refresh token is never bound');
  f.setToken({ access_token: 'different-access-token' });
  await assert.rejects(f.runner.complete(model, 'fixture'), { code: 'MODEL_UNAVAILABLE', reason: 'route_changed' });
  f.setToken();
  writeFileSync(f.device, '11234567-89ab-4def-8123-456789abcdef');
  await assert.rejects(f.runner.complete(model, 'fixture'), { code: 'MODEL_UNAVAILABLE', reason: 'route_changed' });
  writeFileSync(f.device, DEVICE);
  f.setToken({ expires_at: Math.floor(Date.now() / 1000) + 30 });
  await assert.rejects(f.runner.complete(model, 'fixture'), { code: 'MODEL_UNAVAILABLE', reason: 'credential_missing' });
  assert.deepEqual(f.starts, []);
});

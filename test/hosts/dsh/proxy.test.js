import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { requestsTo, startProxy } from './host.js';

test('the dsh Proxy wrapper exposes a child request before the test event loop resumes', async t => {
  const proxy = await startProxy(t);
  const path = '/asset/reuse-result';
  const body = { task_id: 'dsh:wrapped-proxy:1', outcome: 'success' };
  const script = `
    const response = await fetch(process.argv[1], {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: process.argv[2],
    });
    if (!response.ok) throw new Error('The fixture Proxy refused the report');
    await response.text();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script,
    `http://127.0.0.1:${proxy.port}${path}`, JSON.stringify(body)], {
    env: proxy.env, encoding: 'utf8', timeout: 5_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.deepEqual(requestsTo(proxy, path), [{ method: 'POST', path, body }]);
});

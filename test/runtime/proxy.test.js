import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { proxyFetchOf } from '../../lib/runtime/proxy.js';

async function listen(t, handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  return server.address().port;
}

test('Proxy redirects cannot forward a request body to a different origin', async t => {
  let forwarded = 0;
  const destination = await listen(t, (request, response) => {
    forwarded++;
    request.resume();
    response.end('{}');
  });
  const port = await listen(t, (request, response) => {
    request.resume();
    response.writeHead(307, { Location: 'http://127.0.0.1:' + destination + '/redirected' }).end();
  });
  const result = await proxyFetchOf({ EVOMAP_PROXY_PORT: String(port), HOME: import.meta.dirname })('POST', '/conversation/distill', { fixture: 'private draft' });
  assert.equal(forwarded, 0);
  assert.equal(result.ok, false);
});

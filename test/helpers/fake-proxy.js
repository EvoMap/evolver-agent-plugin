import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ASSET } from '../app/memory-ports.js';

/**
 * A loopback Proxy that answers recall with one asset and records every request, plus a scratch HOME whose
 * settings name it as a current Proxy, so no test ever starts setting the engine up. A Recipe search answers
 * `recipes`, and a fetch by ids the `stepAssets` it names. `delays` holds a path's answer back for that many
 * milliseconds; `status` is what `/proxy/status` answers.
 */
export async function fakeProxy({ assets = [ASSET], recipes = [], stepAssets = [], distillAnswer = { ok: false, reason: 'not_in_this_test' }, delays = {}, status = { running: true, status: 'running', node_id: 'node_test' } } = {}) {
  const requests = [];
  const fetched = (body) => (body?.asset_ids ? stepAssets.filter((asset) => body.asset_ids.includes(asset.asset_id)) : assets);
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsed = body ? JSON.parse(body) : undefined;
      requests.push({ method: request.method, path: request.url, body: parsed });
      const answer = request.url === '/asset/fetch' ? { assets: fetched(parsed) }
        : request.url === '/recipe/search' ? recipes
        : request.url === '/proxy/status' ? status
          : request.url === '/conversation/distill' ? distillAnswer
            : { recorded: true };
      const reply = () => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer));
      if (delays[request.url]) setTimeout(reply, delays[request.url]).unref();
      else reply();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = mkdtempSync(join(tmpdir(), 'evolver-home-'));
  const url = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(join(home, '.evolver'));
  writeFileSync(join(home, '.evolver', 'settings.json'), JSON.stringify({ proxy: { url, version: '2.0.47' } }));
  return {
    requests,
    env: { ...process.env, HOME: home, USERPROFILE: home, EVOMAP_PROXY_PORT: String(server.address().port), EVOLVER_HEADLESS: '' },
    close: () => {
      server.close();
      server.closeAllConnections();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

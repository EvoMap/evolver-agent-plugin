import { createServer } from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';

import { recalledFor } from '../app/memory-ports.js';
import { recipeSearchAnswer } from './recipe-search.js';

const { assets, recipes, stepAssets, distillAnswer, delays, status, requests } = workerData;
const fetched = (body) => (body?.asset_ids ? stepAssets.filter((asset) => body.asset_ids.includes(asset.asset_id)) : recalledFor(assets, body));
const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const parsed = body ? JSON.parse(body) : undefined;
    const client = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.startsWith('x-evomap-client-')));
    requests.postMessage({ method: request.method, path: request.url, body: parsed, ...(Object.keys(client).length > 0 && { client }) });
    const answer = request.url === '/asset/fetch' ? { assets: fetched(parsed) }
      : request.url === '/recipe/search' ? recipeSearchAnswer(recipes, parsed)
      : request.url === '/proxy/status' ? status
        : request.url === '/conversation/distill' ? distillAnswer
          : { recorded: true };
    const reply = () => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(answer));
    if (delays[request.url]) setTimeout(reply, delays[request.url]).unref();
    else reply();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
parentPort.postMessage(`http://127.0.0.1:${server.address().port}`);

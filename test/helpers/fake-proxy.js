import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';

import { isSameProcess } from '../../lib/runtime/process/identity.js';
import { ASSET } from '../app/memory-ports.js';

// A verified turn's hook arms a detached waiter for background distillation, which would sleep on past the test.
function endWaiters(home) {
  let entries;
  try { entries = readdirSync(home, { withFileTypes: true }); }
  catch (error) {
    // A worker can release and remove its lock directory while teardown walks the profile.
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const target = join(home, entry.name);
    if (entry.isDirectory()) {
      endWaiters(target);
      continue;
    }
    if (!entry.name.endsWith('-distill-waiter.json')) continue;
    try {
      const { pid, startedAt } = JSON.parse(readFileSync(target, 'utf8'));
      if (isSameProcess(pid, startedAt)) process.kill(pid);
    } catch {
    }
  }
}

/**
 * A loopback Proxy that answers recall with the assets the text names (`recalledFor`) and records every request,
 * plus a scratch HOME whose settings name it as a current Proxy, so no test ever starts setting the engine up. A
 * Recipe search answers `recipes` as the Hub does (judged when it carries a context), and a fetch by ids the
 * `stepAssets` it names. `delays` holds a path's answer back for that many milliseconds; `status` is what
 * `/proxy/status` answers.
 */
export async function fakeProxy({ assets = [ASSET], recipes = [], stepAssets = [], distillAnswer = { ok: false, reason: 'not_in_this_test' }, delays = {}, status = { running: true, status: 'running', node_id: 'node_test' } } = {}) {
  const requests = [];
  const home = mkdtempSync(join(tmpdir(), 'evolver-home-'));
  const { port1, port2 } = new MessageChannel();
  port1.on('message', request => requests.push(request));
  const flushRequests = () => {
    for (let next; (next = receiveMessageOnPort(port1));) requests.push(next.message);
  };
  let worker, url, stopped = false, failure;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    flushRequests();
    port1.close();
    port2.close();
    worker?.terminate();
  };
  try {
    // The real Proxy runs outside a host's event loop, including its synchronous filesystem work.
    worker = new Worker(new URL('./fake-proxy-worker.js', import.meta.url), {
      workerData: { assets, recipes, stepAssets, distillAnswer, delays, status, requests: port2 }, transferList: [port2], execArgv: [],
    });
    worker.on('error', error => { if (!stopped) failure = error; });
    [url] = await Promise.race([
      once(worker, 'message'),
      once(worker, 'exit').then(([code]) => { throw new Error(`Fake Proxy exited before listening (${code})`); }),
    ]);
    mkdirSync(join(home, '.evolver'));
    writeFileSync(join(home, '.evolver', 'settings.json'), JSON.stringify({ proxy: { url, version: '2.0.50' } }));
  } catch (error) {
    stop();
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return {
    get requests() {
      if (failure) throw failure;
      // A child can observe its response before this thread dispatches the request notification.
      flushRequests();
      return requests;
    },
    env: { ...process.env, HOME: home, USERPROFILE: home, EVOMAP_PROXY_PORT: new URL(url).port, EVOLVER_HEADLESS: '' },
    close: () => {
      stop();
      endWaiters(home);
      // A detached worker the hooks started can still be writing its state here after the request a test waits on.
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/** A detached hook worker can still finish a state write after the Proxy received its last request. */
export async function closeProxyWhenSettled(proxy) {
  for (let attempt = 0; ; attempt++) {
    try { return proxy.close(); }
    catch (error) {
      if (attempt === 19 || !['ENOTEMPTY', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

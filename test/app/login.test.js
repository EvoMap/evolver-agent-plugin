import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCommand } from '../../lib/app/commands/index.js';
import { DEVICE_FLOW_MAX_MS } from '../../lib/hub-login.js';
import { deviceText, failedText, signedInText } from '../helpers/login-output.js';
import { memoryPorts } from './memory-ports.js';

const HUB = 'https://evomap.ai';
const URL = 'https://evomap.ai/device?user_code=WDJB-MJHT';
const CODE = 'WDJB-MJHT';
const REGISTERED = { running: true, status: 'running', node_id: 'node_abc', hub_auth_status: 'ok' };

/** A sign-in port over one in-memory run; `onStart(run)` plays what Evolver prints as it starts. */
function fakeSignIn(clock, onStart = () => {}) {
  let current = null;
  const started = [];
  const copy = () => current && { ...current };
  return {
    started,
    print: (text) => { current.output += text; },
    exit: () => { current.isRunning = false; },
    port: {
      latest: async () => copy(),
      joinOrStart: async (isKept) => {
        if (!isKept(copy())) {
          current = { startedAt: clock.now(), isRunning: true, output: '', log: '/state/testagent-login.log' };
          started.push(current);
          onStart(current);
        }
        return copy();
      },
      forget: async (run) => {
        if (current?.startedAt === run?.startedAt) current = null;
      },
    },
  };
}

function loginWorld({ status = REGISTERED, onStart, engine = {} } = {}) {
  const world = memoryPorts();
  const { ports } = world;
  const signIn = fakeSignIn(ports.clock, onStart);
  const state = { status, retried: 0 };
  ports.proxy = { request: async (method, path) => (path === '/proxy/status' && state.status ? { ok: true, data: state.status } : { ok: false, error: 'Proxy connection failed: ECONNREFUSED.' }) };
  ports.signIn = signIn.port;
  ports.engine = { ...ports.engine, retryNow: async () => { state.retried += 1; }, ...engine };
  const login = () => runCommand(ports, { sessionId: 's1', name: 'evolver-login' });
  return { ...world, ports, signIn, state, login };
}

const printsDeviceCode = (run) => { run.output = deviceText(URL, CODE); };

test('with the engine missing, the same setup a session start runs is scheduled at once, and signing in follows', async () => {
  const world = loginWorld({ status: null, onStart: printsDeviceCode });
  world.ports.scheduler = { schedule: (tasks) => { world.scheduled.push(...tasks); world.state.status = REGISTERED; } };
  const answer = await world.login();
  assert.deepEqual(world.scheduled, ['engine']);
  assert.equal(world.state.retried, 1, 'a setup waiting out its retry delay runs now: the person asked');
  assert.equal(answer.ok, true);
  assert.ok(answer.text.includes(`open ${URL} and enter the code ${CODE}.`), answer.text);
});

test('a setup that fails says what failed and what to do, and starts no sign-in', async () => {
  let outcome = { status: 'install_failed', error: 'old', at: 1 };
  const world = loginWorld({ status: null, onStart: printsDeviceCode, engine: { outcome: async () => outcome } });
  world.ports.scheduler = { schedule: () => { outcome = { status: 'install_failed', error: 'npm ERR! network', at: 2, failures: 2 }; } };
  const answer = await world.login();
  assert.equal(answer.ok, false);
  assert.match(answer.text, /^Evolver is not ready, so signing in to the EvoMap Hub cannot start\.\n\[Evolver\] Installing Evolver failed \(npm ERR! network\)\. To set it up by hand: `npm install -g @evomap\/evolver@latest`/);
  assert.deepEqual(world.signIn.started, []);
});

test('a setup still running when the wait is over leaves the person a next step, and starts no sign-in', async () => {
  const world = loginWorld({ status: null, onStart: printsDeviceCode });
  const answer = await world.login();
  assert.deepEqual([answer.ok, answer.text], [true, 'Evolver is still being set up (installing it can take a few minutes); run /evolver-login again in a minute to sign in.']);
  assert.deepEqual(world.signIn.started, []);
});

test('already signed in: Evolver answers at once from its stored token, and the Proxy names the node', async () => {
  const world = loginWorld({ onStart: (run) => { run.output = signedInText(HUB); run.isRunning = false; } });
  assert.deepEqual(await world.login(), { ok: true, text: `Signed in to ${HUB}; node node_abc registered.` });
  assert.deepEqual(world.scheduled, [], 'a running Proxy needs no setup');
  assert.equal(await world.ports.signIn.latest(), null, 'the answered run is forgotten');
});

test('not signed in: the link and code are answered, and a second /evolver-login shows the same ones', async () => {
  const world = loginWorld({ onStart: printsDeviceCode });
  const first = await world.login();
  assert.deepEqual(first, { ok: true, text: `To sign in to the EvoMap Hub, open ${URL} and enter the code ${CODE}. Evolver finishes signing in once you approve; then run /evolver-login again to confirm.` });
  world.advance(60_000);
  assert.deepEqual(await world.login(), first);
  assert.equal(world.signIn.started.length, 1);
});

test('once approved, the next /evolver-login reports the node, and the one after asks Evolver afresh', async () => {
  const world = loginWorld({ onStart: printsDeviceCode });
  await world.login();
  world.signIn.print(signedInText(HUB));
  world.signIn.exit();
  assert.deepEqual(await world.login(), { ok: true, text: `Signed in to ${HUB}; node node_abc registered.` });
  assert.equal(world.signIn.started.length, 1);
  await world.login();
  assert.equal(world.signIn.started.length, 2, 'a finished run is answered once');
});

test("a failed or expired sign-in reports Evolver's message, then a fresh one starts when asked again", async () => {
  const world = loginWorld({ onStart: printsDeviceCode });
  await world.login();
  world.signIn.print(failedText('device_flow_timeout'));
  world.signIn.exit();
  assert.deepEqual(await world.login(), { ok: false, text: 'Signing in to the EvoMap Hub failed: device_flow_timeout. Run /evolver-login again to start over.' });
  assert.ok((await world.login()).text.includes(`enter the code ${CODE}.`));
  assert.equal(world.signIn.started.length, 2);
});

test('signed in while the Proxy registers no node: says so, with the status it reported', async () => {
  const world = loginWorld({
    status: { running: true, node_id: null, hub_auth_status: 'auth_failed', last_sync_error: 'hub 401' },
    onStart: (run) => { run.output = signedInText(HUB); },
  });
  assert.deepEqual(await world.login(), {
    ok: false,
    text: `Signed in to ${HUB}, but the Evolver Proxy reports no registered node (Hub auth auth_failed, node none, last Hub sync failed: hub 401). The Proxy registers the node itself; /evolver-status shows when it has.`,
  });
});

test('one sign-in at a time: two /evolver-login at once share one run and its code', async () => {
  const world = loginWorld({ onStart: printsDeviceCode });
  const [first, second] = await Promise.all([world.login(), world.login()]);
  assert.equal(world.signIn.started.length, 1);
  assert.equal(first.text, second.text);
});

test('a run quiet past the wait asks for another try; one past the device flow\'s life is replaced', async () => {
  const world = loginWorld();
  assert.deepEqual(await world.login(), { ok: true, text: "Evolver's sign-in has started but has not shown its code yet; run /evolver-login again in a few seconds." });
  world.advance(DEVICE_FLOW_MAX_MS + 1);
  await world.login();
  assert.equal(world.signIn.started.length, 2);
});

test('/evolver-status shows a sign-in waiting for approval, and otherwise points to /evolver-login', async () => {
  const world = loginWorld({ onStart: printsDeviceCode });
  const status = () => runCommand(world.ports, { sessionId: 's1', name: 'evolver-status' }).then((answer) => answer.text.split('\n').at(-1));
  assert.equal(await status(), 'Hub sign-in: /evolver-login signs you in to the EvoMap Hub, or confirms that you are.');
  await world.login();
  assert.equal(await status(), `A sign-in to the EvoMap Hub waits for your approval: open ${URL} and enter the code ${CODE}.`);
});

test('a run finished long ago is not answered: a success after an `evolver logout`, or an old unseen timeout, starts afresh', async () => {
  const world = loginWorld({ onStart: printsDeviceCode });
  await world.login();
  world.signIn.print(failedText('device_flow_timeout'));
  world.signIn.exit();
  world.advance(DEVICE_FLOW_MAX_MS + 1);
  assert.ok((await world.login()).text.includes(`enter the code ${CODE}.`), 'the first call after shows a fresh code');
  assert.equal(world.signIn.started.length, 2);
});

test('the whole answer comes within 45 s, the engine and Evolver sharing one deadline, and a cancel ends the wait', async () => {
  const world = loginWorld({ status: null });
  const startedAt = world.ports.clock.now();
  const proxy = world.ports.proxy.request;
  world.ports.proxy = { request: async (...args) => {
    if (world.ports.clock.now() - startedAt >= 44_000) world.state.status = REGISTERED;
    return proxy(...args);
  } };
  const answer = await world.login();
  assert.ok(world.ports.clock.now() - startedAt <= 45_000, `answered after ${world.ports.clock.now() - startedAt} ms`);
  assert.match(answer.text, /has not shown its code yet/);

  const cancelled = loginWorld({ status: null });
  const cancelledAt = cancelled.ports.clock.now();
  await runCommand(cancelled.ports, { sessionId: 's1', name: 'evolver-login', signal: AbortSignal.abort() });
  assert.equal(cancelled.ports.clock.now(), cancelledAt);
});

test('when another process holds the start and shows no run, the answer says so instead of waiting on nothing', async () => {
  const world = loginWorld({ onStart: printsDeviceCode });
  world.ports.signIn = { ...world.ports.signIn, joinOrStart: async () => null };
  assert.deepEqual(await world.login(), { ok: true, text: 'Another sign-in to the EvoMap Hub is starting; run /evolver-login again in a minute.' });
});

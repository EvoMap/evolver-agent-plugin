// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { engineNoticeOf } from '../../engine/notice.js';
import { FAILURES } from '../../engine/setup.js';
import { SIGN_IN, isFinished, needsNewRun, signInOf } from '../../hub-login.js';
import { registeredNodeOf, registrationText } from '../../proxy-status.js';
import { TASKS } from '../ports.js';
import { failure, success } from './result.js';

// Both waits together stay under a minute, inside what a host gives a command or an MCP tool call to answer; what is
// not done by then goes on in the background, and the next /evolver-login picks it up.
const ENGINE_WAIT_MS = 45_000;
const ENGINE_POLL_MS = 1_000;
const ANSWER_WAIT_MS = 10_000;
const ANSWER_POLL_MS = 200;
const STATUS_TIMEOUT_MS = 3_000;

async function proxyStatusOf({ proxy }) {
  return proxy.request('GET', '/proxy/status', undefined, { timeoutMs: STATUS_TIMEOUT_MS });
}

async function isProxyRunning(ports) {
  const answered = await proxyStatusOf(ports);
  return answered.ok && answered.data?.running === true;
}

/** Null once the engine's Proxy answers; else the answer that says why signing in cannot start yet. */
async function engineNotReady(ports) {
  if (await isProxyRunning(ports)) return null;
  const { engine, scheduler, clock, identity } = ports;
  const before = await engine.outcome();
  await engine.retryNow();
  scheduler.schedule([TASKS.ENGINE]);
  const deadline = clock.now() + ENGINE_WAIT_MS;
  while (clock.now() < deadline) {
    await clock.sleep(ENGINE_POLL_MS);
    if (await isProxyRunning(ports)) return null;
    const outcome = await engine.outcome();
    if (outcome && outcome.at !== before?.at && FAILURES.has(outcome.status)) {
      return failure(`Evolver is not ready, so signing in to the EvoMap Hub cannot start.\n${engineNoticeOf(outcome, identity.label)}`);
    }
  }
  return success('Evolver is still being set up (installing it can take a few minutes); run /evolver-login again in a minute to sign in.');
}

async function firstAnswerOf({ signIn, clock }) {
  const deadline = clock.now() + ANSWER_WAIT_MS;
  for (;;) {
    const run = await signIn.latest();
    const state = signInOf(run, clock.now());
    if (state.state !== SIGN_IN.STARTING || clock.now() >= deadline) return { run, state };
    await clock.sleep(ANSWER_POLL_MS);
  }
}

async function signedInAnswer(ports, hub) {
  const answered = await proxyStatusOf(ports);
  if (!answered.ok) return failure(`Signed in to ${hub}, but the Evolver Proxy did not answer: ${answered.error}`);
  const node = registeredNodeOf(answered.data);
  if (node) return success(`Signed in to ${hub}; node ${node} registered.`);
  return failure(`Signed in to ${hub}, but the Evolver Proxy reports no registered node (${registrationText(answered.data)}). `
    + 'The Proxy registers the node itself; /evolver-status shows when it has.');
}

const ANSWERS = {
  [SIGN_IN.WAITING]: ({ url, code }) => success(`To sign in to the EvoMap Hub, open ${url} and enter the code ${code}. `
    + `Evolver finishes signing in once you approve; then run /evolver-login again to confirm.`),
  [SIGN_IN.SIGNED_IN]: ({ hub }, ports) => signedInAnswer(ports, hub),
  [SIGN_IN.FAILED]: ({ reason }) => failure(`Signing in to the EvoMap Hub failed: ${reason}. Run /evolver-login again to start over.`),
};

const notShownYet = () => success("Evolver's sign-in has started but has not shown its code yet; run /evolver-login again in a few seconds.");

// The person's answer comes from Evolver's own `evolver login`: it reuses a stored token that is still valid and
// answers at once, and otherwise starts the device authorization. The Proxy reports its Hub link the same either way,
// so it cannot tell whether the person signed in, only which node it registered.
export default {
  name: 'evolver-login',
  description: 'Sign in to the EvoMap Hub with a device code, setting Evolver up first when needed, and show the registered node.',
  async run(ports) {
    const notReady = await engineNotReady(ports);
    if (notReady) return notReady;
    await ports.signIn.joinOrStart((run) => !needsNewRun(signInOf(run, ports.clock.now())));
    const { run, state } = await firstAnswerOf(ports);
    const answer = await (ANSWERS[state.state] ?? notShownYet)(state, ports);
    if (isFinished(state)) await ports.signIn.forget(run);
    return answer;
  },
};

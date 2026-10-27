import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEVICE_FLOW_MAX_MS, SIGN_IN, START_MAX_MS, isFinished, needsNewRun, signInOf } from '../lib/hub-login.js';
import { deviceText, failedText, signedInText } from './helpers/login-output.js';

const INSECURE_WARNING = '[hubFetch] WARNING: EVOMAP_HUB_ALLOW_INSECURE=1 — https guard and TLS enforcement are DISABLED. Hub egress may be plaintext/unverified. Local dev / mock hub only, never production.\n';

const NOW = 10_000_000;
const running = (output, startedAt = NOW - 1_000) => ({ startedAt, isRunning: true, output, log: '/state/agent-login.log' });
const ended = (output) => ({ ...running(output), isRunning: false });

test('the device prompt gives the link and the code, while Evolver waits for the approval', () => {
  const url = 'https://evomap.ai/device?user_code=WDJB-MJHT';
  assert.deepEqual(signInOf(running(deviceText(url, 'WDJB-MJHT')), NOW), { state: SIGN_IN.WAITING, url, code: 'WDJB-MJHT' });
  assert.deepEqual(signInOf(running(`npm warn exec installing @evomap/evolver\n${INSECURE_WARNING}${deviceText(url, 'AB-12')}`), NOW).code, 'AB-12');
});

test('the success line names the Hub, also when a stored token answered without a device prompt', () => {
  const hub = 'http://127.0.0.1:65194';
  assert.deepEqual(signInOf(ended(`${deviceText('https://hub.test/device', 'X-1')}${signedInText(hub)}`), NOW), { state: SIGN_IN.SIGNED_IN, hub });
  assert.deepEqual(signInOf(running(signedInText('https://evomap.ai')), NOW), { state: SIGN_IN.SIGNED_IN, hub: 'https://evomap.ai' });
});

test("a failure is Evolver's own message: denied, expired, unreachable", () => {
  const denied = `${INSECURE_WARNING}${deviceText('https://hub.test/device', 'X-1')}${failedText('token poll failed (HTTP 400): access_denied')}`;
  assert.deepEqual(signInOf(ended(denied), NOW), { state: SIGN_IN.FAILED, reason: 'token poll failed (HTTP 400): access_denied' });
  assert.equal(signInOf(ended(failedText('device_flow_timeout')), NOW).reason, 'device_flow_timeout');
  assert.equal(signInOf(running(failedText('fetch failed')), NOW).reason, 'fetch failed');
});

test('a run that ended without an answer failed and points to its output; one still quiet is starting', () => {
  assert.deepEqual(signInOf(ended(deviceText('https://hub.test/device', 'X-1')), NOW), {
    state: SIGN_IN.FAILED, reason: 'Evolver ended without an answer (its output is in /state/agent-login.log)',
  });
  assert.deepEqual(signInOf(running(''), NOW), { state: SIGN_IN.STARTING });
  assert.deepEqual(signInOf(running('\nTo authorize this device:\n  1. open  \n  2. enter code:  X-1\n'), NOW), { state: SIGN_IN.STARTING }, 'no link, no prompt');
});

test('a run past the device flow\'s 15 minutes that still looks alive is stale, and only none or stale is replaced', () => {
  const old = running(deviceText('https://hub.test/device', 'X-1'), NOW - DEVICE_FLOW_MAX_MS - 1);
  assert.deepEqual(signInOf(old, NOW), { state: SIGN_IN.STALE });
  const longAgo = NOW - DEVICE_FLOW_MAX_MS - 1;
  assert.deepEqual(signInOf({ ...ended(signedInText('https://evomap.ai')), startedAt: longAgo }, NOW), { state: SIGN_IN.STALE }, 'an old success says nothing of now');
  assert.deepEqual(signInOf({ ...ended(failedText('device_flow_timeout')), startedAt: longAgo }, NOW), { state: SIGN_IN.STALE });
  assert.deepEqual(signInOf(null, NOW), { state: SIGN_IN.NONE });
  const states = [null, old, running(''), running(deviceText('u', 'c')), ended(signedInText('h')), ended(failedText('x'))].map((run) => signInOf(run, NOW));
  assert.deepEqual(states.map(needsNewRun), [true, true, false, false, false, false]);
  assert.deepEqual(states.map(isFinished), [false, false, false, false, true, true]);
});

test('a run that shows no code within 2 minutes failed, though it still runs: npx still fetching, or a hang', () => {
  assert.deepEqual(signInOf(running('npm warn exec installing @evomap/evolver\n', NOW - START_MAX_MS - 1), NOW), {
    state: SIGN_IN.FAILED, reason: 'Evolver showed no code within 2 minutes (its output is in /state/agent-login.log)',
  });
  assert.equal(signInOf(running(deviceText('u', 'c'), NOW - START_MAX_MS - 1), NOW).state, SIGN_IN.WAITING, 'a code shown keeps it waiting');
});

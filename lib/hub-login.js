// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// Where a background `evolver login` stands, read from what Evolver printed. Its device authorization prints
// `  1. open  <url>` and `  2. enter code:  <code>`, then exactly one of `✓ Logged in to <hub>. Token stored at …`
// (also at once, when a stored token is still valid) or `login failed: <reason>` before it exits.

const DEVICE_PROMPT = /^[ \t]*1\. open[ \t]+(\S+)[ \t]*\r?\n[ \t]*2\. enter code:[ \t]+(\S+)/m;
const SIGNED_IN = /✓ Logged in to (\S+?)\. Token stored at /;
const FAILED = /^login failed: (.+)$/m;

// Evolver stops waiting for an approval after 15 minutes, so a run older than that is over: what it answered then says
// nothing of now (the token may have expired, or `evolver logout` removed it), and one that still looks alive is
// another process that took over its pid.
export const DEVICE_FLOW_MAX_MS = 16 * 60 * 1000;
// Evolver shows its code within a second; minutes more is npx still fetching it, or a run that hangs.
export const START_MAX_MS = 2 * 60 * 1000;

export const SIGN_IN = Object.freeze({
  NONE: 'none',
  STARTING: 'starting',
  WAITING: 'waiting',
  SIGNED_IN: 'signed-in',
  FAILED: 'failed',
  STALE: 'stale',
});

/**
 * The state of `run` (`{ startedAt, isRunning, output, log }`, or null when none was started): starting, waiting
 * for approval with its `url` and `code`, signed in to `hub`, failed with Evolver's `reason`, or stale.
 */
export function signInOf(run, now) {
  if (!run) return { state: SIGN_IN.NONE };
  if (now - run.startedAt > DEVICE_FLOW_MAX_MS) return { state: SIGN_IN.STALE };
  const output = String(run.output ?? '');
  const signedIn = SIGNED_IN.exec(output);
  if (signedIn) return { state: SIGN_IN.SIGNED_IN, hub: signedIn[1] };
  const failed = FAILED.exec(output);
  if (failed) return { state: SIGN_IN.FAILED, reason: failed[1].trim() };
  if (!run.isRunning) return { state: SIGN_IN.FAILED, reason: `Evolver ended without an answer (its output is in ${run.log})` };
  const device = DEVICE_PROMPT.exec(output);
  if (device) return { state: SIGN_IN.WAITING, url: device[1], code: device[2] };
  if (now - run.startedAt > START_MAX_MS) return { state: SIGN_IN.FAILED, reason: `Evolver showed no code within 2 minutes (its output is in ${run.log})` };
  return { state: SIGN_IN.STARTING };
}

/** Whether a new `evolver login` should replace this one: there is none, or it is stale. */
export const needsNewRun = ({ state }) => state === SIGN_IN.NONE || state === SIGN_IN.STALE;

/** Whether Evolver has answered for good: reported once, then forgotten, so the next sign-in starts afresh. */
export const isFinished = ({ state }) => state === SIGN_IN.SIGNED_IN || state === SIGN_IN.FAILED;

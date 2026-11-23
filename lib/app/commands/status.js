// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { lastOutcomeText } from '../../distill/outcomes.js';
import { rangeOf } from '../../distill/range.js';
import { engineSetupOf } from '../../engine/report.js';
import { MIN_EVOLVER_VERSION } from '../../engine/version.js';
import { SIGN_IN, signInOf } from '../../hub-login.js';
import { proxyStatusOf, publishingOf } from '../../proxy-status.js';
import { success } from './result.js';

function waitingWorkOf(pending, { sessionId, anySession }) {
  if (anySession) return { sessions_waiting: Object.keys(pending).length };
  return { session_turns_waiting: rangeOf(pending, sessionId)?.turns.length ?? 0 };
}

const SIGN_IN_LINES = {
  [SIGN_IN.STARTING]: () => 'A sign-in to the EvoMap Hub is starting; /evolver-login shows its link and code.',
  [SIGN_IN.WAITING]: ({ url, code }) => `A sign-in to the EvoMap Hub waits for your approval: open ${url} and enter the code ${code}.`,
  [SIGN_IN.SIGNED_IN]: ({ hub }) => `Signed in to ${hub}; /evolver-login shows the registered node.`,
  [SIGN_IN.FAILED]: ({ reason }) => `The last sign-in to the EvoMap Hub failed (${reason}); /evolver-login starts a new one.`,
};

function signInLine(state) {
  return SIGN_IN_LINES[state.state]?.(state) ?? '/evolver-login signs you in to the EvoMap Hub; within about an hour of an approval it answers at once, after that it asks for a new one.';
}

function chosenSettingsOf(settings) {
  if (!settings) return null;
  return { recall: settings.recall, auto_distill: settings.autoDistill, ...(settings.file && { file: settings.file }), ...(settings.error && { error: settings.error }) };
}

// The version is read from the Proxy's settings record and the status from its answer, in two calls; across a
// restart they can describe different processes, so a version whose process is not the one answering is not shown.
function versionOfAnswering(answered, recorded) {
  const answeringPid = answered.ok ? answered.data?.health?.pid : undefined;
  const isOtherProcess = Number.isInteger(answeringPid) && Number.isInteger(recorded?.pid) && answeringPid !== recorded.pid;
  return isOtherProcess ? null : recorded?.version ?? null;
}

function proxyOf(answered, version) {
  const status = answered.ok ? proxyStatusOf(answered.data) : { running: false, error: answered.error };
  return { version, ...status };
}

export default {
  name: 'evolver-status',
  description: 'Evolver health: the Proxy, engine setup, Hub sign-in, the work waiting to be distilled, the last distillation and drafts.',
  async run({ identity, client, proxy, engine, candidates, drafts, outcomes, signIn, clock, settings }, { sessionId, anySession }) {
    const [answered, current] = await Promise.all([proxy.request('GET', '/proxy/status', undefined, { timeoutMs: 3_000 }), engine.current()]);
    const versions = client.versions();
    const publishing = answered.ok ? publishingOf(answered.data) : null;
    const proxyVersion = versionOfAnswering(answered, current.proxy);
    return success(JSON.stringify({
      plugin: { name: versions.plugin, version: versions.pluginVersion },
      agent: { name: identity.agent, label: identity.label, version: versions.agentVersion },
      evolver: { required: `>=${MIN_EVOLVER_VERSION}`, installed: current.installed, proxy: proxyOf(answered, proxyVersion) },
      engine_setup: engineSetupOf(await engine.outcome(), proxyVersion, identity.label),
      ...(publishing && { publishing }),
      distillation: {
        ...waitingWorkOf(await candidates.read(), { sessionId, anySession }),
        last: lastOutcomeText(await outcomes?.read(), clock.now()),
        drafts_waiting: (await drafts.read()).length,
      },
      ...(settings && { settings: chosenSettingsOf(settings) }),
      hub_sign_in: signInLine(signInOf(await signIn.latest(), clock.now())),
    }, null, 2));
  },
};

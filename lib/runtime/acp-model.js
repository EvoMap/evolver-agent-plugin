// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { markHeadlessWorkdir } from './headless.js';
import { ModelUnavailable, sameSnapshot, selectedConfig } from './native-config.js';
import { CHILD_FILE, guardianFile, OWNER_FILE, START_FILE } from './process/acp-child.js';
import { nodeExecutable } from './process/node.js';
import { executableOf } from './process/which.js';

const CREDENTIAL_ENV = 'EVOLVER_MODEL_API_KEY';
const OUTPUT_MAX = 16 * 1024 * 1024;
const pidGone = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
};

function failure(code = 'ACP_MODEL_FAILED') {
  return Object.assign(new Error(code === 'ABORT_ERR' ? 'Model completion was cancelled' : 'Native model completion did not finish safely'), { code });
}

async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise(done => { timer = setTimeout(done, ms); })]); }
  finally { clearTimeout(timer); }
}

function beneath(home, path, allowSelf = false) {
  const rel = relative(resolve(home), resolve(path));
  if ((!rel && !allowSelf) || rel.startsWith('..') || isAbsolute(rel)) throw new ModelUnavailable('unsafe_runtime');
  return resolve(path);
}

function filesPrepared(declaration, selected, home, secret) {
  let prepared;
  try { prepared = declaration.prepare(selected, { home, credentialEnv: CREDENTIAL_ENV }); }
  catch { throw new ModelUnavailable('unsafe_runtime'); }
  const files = Object.entries(prepared?.files ?? {}).map(([path, entry]) => {
    const target = beneath(home, join(home, path));
    if (isAbsolute(path)) throw new ModelUnavailable('unsafe_runtime');
    const text = entry?.format === 'config' ? declaration.config.serializeConfig(entry.value) : entry?.format === 'text' ? entry.value : null;
    if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024 || text.includes(secret)) throw new ModelUnavailable('unsafe_runtime');
    return { target, text };
  });
  if (!files.length || files.length > 16) throw new ModelUnavailable('unsafe_runtime');
  for (const { target, text } of files) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, text, { mode: 0o600, flag: 'wx' });
  }
  return prepared.env ?? {};
}

function privateEnv(original, extra, home, secret) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'RUNNER_TRACKING_ID', 'ProgramW6432', 'ProgramFiles']) {
    if (original[key] !== undefined) env[key] = original[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value !== 'string' || value.includes(secret) || /(?:KEY|TOKEN|AUTH|SECRET)/i.test(key)) throw new ModelUnavailable('unsafe_runtime');
    if (/(?:^|_)HOME$/.test(key)) beneath(home, value, true);
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'), TMPDIR: join(home, 'tmp'),
    EVOLVER_HEADLESS: '1', CI: '1', NO_COLOR: '1', [CREDENTIAL_ENV]: secret,
  });
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'TEMP']) mkdirSync(env[key], { recursive: true, mode: 0o700 });
  return env;
}

function orphanMarker(home, uid) {
  for (const name of [START_FILE, OWNER_FILE]) {
    const file = join(home, name);
    try {
      const mark = lstatSync(file);
      if (!mark.isFile() || mark.isSymbolicLink() || mark.size > 2048 || (uid !== undefined && mark.uid !== uid)) return;
      return { file, owner: JSON.parse(readFileSync(file, 'utf8')), beforeLaunch: name === START_FILE };
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

function cleanOrphans(base, origin) {
  const uid = process.getuid?.();
  let seen = 0;
  for (const name of readdirSync(base)) {
    if (!name.startsWith('evolver-model-') || ++seen > 256) continue;
    const home = join(base, name);
    try {
      const stat = lstatSync(home);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) continue;
      const marker = orphanMarker(home, uid);
      if (!marker) continue;
      const { owner, beforeLaunch, file } = marker;
      if (owner.origin !== origin || !/^[a-f0-9]{32}$/.test(owner.nonce ?? '') || !Number.isSafeInteger(owner.ownerPid) || owner.ownerPid <= 0) continue;
      if (!pidGone(owner.ownerPid)) continue;
      if (dirname(realpathSync(home)) !== realpathSync(base)) throw new ModelUnavailable('unsafe_runtime');
      if (beforeLaunch) {
        // Either recovery unlinks the permit or the guardian renames it before spawning.
        try { unlinkSync(file); } catch { throw new ModelUnavailable('unsafe_runtime'); }
        rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        continue;
      }
      const childFile = join(home, CHILD_FILE);
      let child;
      try {
        const childStat = lstatSync(childFile);
        if (!childStat.isFile() || childStat.isSymbolicLink() || childStat.size > 2048) throw new ModelUnavailable('unsafe_runtime');
        if (uid !== undefined && childStat.uid !== uid) continue;
        child = JSON.parse(readFileSync(childFile, 'utf8'));
        if (child.nonce !== owner.nonce || ![child.guardianPid, child.nativePid].every(pid => Number.isSafeInteger(pid) && pid > 0)) throw new ModelUnavailable('unsafe_runtime');
      } catch { throw new ModelUnavailable('unsafe_runtime'); }
      // An old PID may now belong to somebody else. Recovery never signals one without a live child handle.
      const pids = [child.guardianPid, child.nativePid];
      if (process.platform === 'win32') {
        if (child.jobEmpty !== true || !Number.isSafeInteger(child.helperPid) || child.helperPid <= 0) throw new ModelUnavailable('unsafe_runtime');
        pids.push(child.helperPid);
      }
      if (!pids.every(pidGone)) throw new ModelUnavailable('unsafe_runtime');
      rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) { if (error?.code === 'MODEL_UNAVAILABLE') throw error; }
  }
}

function nativeFacts(declaration, home) {
  const root = beneath(home, declaration.facts.root(home), true);
  let bytes = 0, files = 0;
  const records = [];
  const visit = dir => {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !realpathSync(dir).startsWith(realpathSync(home))) throw failure();
    for (const name of readdirSync(dir)) {
      const file = join(dir, name), item = lstatSync(file);
      if (item.isSymbolicLink()) throw failure();
      if (item.isDirectory()) visit(file);
      else if (item.isFile() && name === declaration.facts.logName) {
        if (++files > 16 || (bytes += item.size) > OUTPUT_MAX) throw failure();
        const text = readFileSync(file, 'utf8');
        if (!text.endsWith('\n')) throw failure();
        for (const line of text.split('\n')) if (line.trim()) records.push(JSON.parse(line));
      }
    }
  };
  visit(root);
  return declaration.facts.decode(records);
}

function validateFacts(facts, route) {
  if (!facts || facts.reason !== 'completed' || facts.error || facts.providerFinish !== 'completed'
      || facts.model !== route.model || facts.alias !== route.alias || facts.protocol !== route.protocol
      || (route.effort !== undefined && facts.thinkingEffort !== route.effort)
      || !Array.isArray(facts.toolSnapshots) || !facts.toolSnapshots.length || facts.toolSnapshots.some(count => count !== 0)
      || facts.toolCalls !== 0) throw failure();
}

function conversation(child, signal) {
  const pending = new Map(), messages = [];
  let next = 0, buffer = '', bytes = 0, error, guardianResult, nativeResult, outputComplete = false, cleaned = false, stopped, promptFinished = false;
  const phases = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const nativeClosed = new Promise(done => { stopped = done; });
  const nativeReady = Promise.withResolvers();
  const finishOutput = () => {
    if (nativeResult && bytes === nativeResult.outputBytes && !outputComplete) {
      outputComplete = true;
      try { buffer += decoder.decode(); } catch { fail(failure('ACP_PROTOCOL_ERROR')); }
      if (buffer.trim()) fail(failure('ACP_PROTOCOL_ERROR'));
      if (pending.size) fail(error ?? failure());
      stopped();
    }
  };
  const fail = cause => {
    error ??= cause;
    nativeReady.resolve(false);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  child.stdin.on('error', () => {});
  child.stderr.on('data', () => {});
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    try { buffer += decoder.decode(chunk, { stream: true }); } catch { fail(failure('ACP_PROTOCOL_ERROR')); }
    if (bytes > OUTPUT_MAX) { fail(failure('ACP_OUTPUT_LIMIT')); return; }
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail(failure('ACP_PROTOCOL_ERROR')); continue; }
      if (message?.jsonrpc !== '2.0' || typeof message !== 'object') { fail(failure('ACP_PROTOCOL_ERROR')); continue; }
      if (message.method !== undefined) {
        if (message.id !== undefined || message.method !== 'session/update') { fail(failure('ACP_UNEXPECTED_REQUEST')); continue; }
        if (/^tool_call/.test(message.params?.update?.sessionUpdate ?? '')) { fail(failure('ACP_UNEXPECTED_REQUEST')); continue; }
        if (promptFinished && message.params?.update?.sessionUpdate === 'agent_message_chunk') { fail(failure('ACP_PROTOCOL_ERROR')); continue; }
        messages.push(message.params);
      } else if (Number.isSafeInteger(message.id) && pending.has(message.id)) {
        const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
        if (entry.method === 'session/prompt') promptFinished = true;
        if (message.error) entry.reject(failure()); else entry.resolve(message.result);
      } else fail(failure('ACP_PROTOCOL_ERROR'));
    }
    finishOutput();
  });
  child.on('message', message => {
    if (message?.type === 'phase' && /^[a-z0-9_-]{1,32}$/.test(message.value) && phases.length < 12) phases.push(message.value);
    if (message?.type === 'spawned') nativeReady.resolve(true);
    if (message?.type === 'closed') { nativeReady.resolve(false); nativeResult = message; child.stdin.end(); finishOutput(); }
    if (message?.type === 'cleanup') cleaned = message.cleaned === true;
  });
  const closed = new Promise(done => {
    child.on('error', () => { fail(failure()); });
    child.on('close', (code, signalName) => {
      guardianResult = { code, signal: signalName };
      if (buffer.trim()) fail(failure('ACP_PROTOCOL_ERROR'));
      if (pending.size) fail(error ?? failure());
      stopped();
      nativeReady.resolve(false);
      done(guardianResult);
    });
  });
  const abort = () => { fail(failure('ABORT_ERR')); if (child.connected) child.send({ type: 'stop' }); child.stdin.end(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const request = (method, params, ms) => new Promise((resolve, reject) => {
    if (error) { reject(error); return; }
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(failure('ACP_TIMEOUT')); }, ms);
    pending.set(id, { method, resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return {
    request, closed, messages,
    async waitForNative() {
      if (await within(nativeReady.promise, 20_000)) return;
      throw error ?? failure('ACP_STARTUP_FAILED');
    },
    cleanupFailure() {
      const cause = failure('ACP_CLEANUP_FAILED');
      if (process.platform === 'win32') cause.message += ' (Windows job: ' + (phases.join(', ') || 'guardian-unconfirmed') + ')';
      return cause;
    },
    get error() { return error; }, get nativeResult() { return nativeResult; }, get guardianResult() { return guardianResult; },
    async dispose(sessionId) {
      signal?.removeEventListener('abort', abort);
      if (!error && !guardianResult && sessionId) try { await request('session/close', { sessionId }, 2000); } catch {}
      child.stdin.end();
      await within(nativeClosed, 1500);
      if (!nativeResult && !guardianResult) { if (child.connected) child.send({ type: 'stop' }); await within(nativeClosed, 4000); }
      if (!nativeResult && !guardianResult) {
        if (process.platform === 'win32') {
          // The helper's job closes independently when it loses the guardian.
          try { child.kill('SIGKILL'); } catch {}
        } else {
          // The guardian owns the native process group. Let it finish cleanup after losing IPC.
          if (child.connected) child.disconnect();
          child.unref();
          child.stdout.destroy();
          child.stderr.destroy();
        }
        await within(closed, 500);
      }
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(failure()); }
      pending.clear();
      return Boolean(outputComplete && nativeResult?.treeClosed);
    },
    async release() {
      if (child.connected) child.send({ type: 'release' });
      await within(closed, 2000);
      return Boolean(guardianResult && cleaned);
    },
  };
}

export function acpModelRunnerOf(declaration, env) {
  return {
    capture: hint => selectedConfig(declaration, hint, env).snapshot,
    complete: async (snapshot, prompt, signal) => {
      if (signal?.aborted) throw failure('ABORT_ERR');
      const selected = selectedConfig(declaration, snapshot, env);
      if (!sameSnapshot(selected.snapshot, snapshot)) throw new ModelUnavailable('route_changed');
      const found = typeof declaration.command === 'function'
        ? { file: declaration.command(env), viaNode: false }
        : executableOf({ ...declaration.command, dirs: declaration.command?.dirs?.(env) ?? [] }, { env });
      if (!found?.file || /\.(?:cmd|bat)$/i.test(found.file)) throw new ModelUnavailable('unsafe_runtime');
      const command = found.viaNode ? nodeExecutable() : found.file;
      const leading = found.viaNode ? [found.file] : [];
      const base = tmpdir(); cleanOrphans(base, selected.origin);
      const home = mkdtempSync(join(base, 'evolver-model-')), nonce = randomBytes(16).toString('hex');
      let sessionId, channel, answer, facts, callStarted = false, safeToRemove = true, thrown;
      try {
        markHeadlessWorkdir(home);
        writeFileSync(join(home, START_FILE), JSON.stringify({ nonce, origin: selected.origin, ownerPid: process.pid }), { mode: 0o600, flag: 'wx' });
        const extra = filesPrepared(declaration, selected.selected, home, selected.secret);
        const runEnv = privateEnv(env, extra, home, selected.secret);
        const cwd = join(home, 'workspace'); mkdirSync(cwd, { mode: 0o700 });
        const args = [...leading, ...declaration.args(snapshot, { home })];
        if (args.some(arg => typeof arg !== 'string' || arg.includes(selected.secret))) throw new ModelUnavailable('unsafe_runtime');
        const spec = { command, args, home, cwd, base, nonce, ownerPid: process.pid };
        // A separate process group survives host termination long enough to reap its owned native child.
        const child = fork(guardianFile, [JSON.stringify(spec)], { execPath: nodeExecutable(), execArgv: [], env: runEnv, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
        safeToRemove = false;
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 90_000);
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        channel = conversation(child, combined);
        try {
          // The helper can compile before launching the client. The protocol clock starts after launch.
          if (process.platform === 'win32') await channel.waitForNative();
          const init = await channel.request('initialize', { protocolVersion: 1, clientInfo: { name: 'evolver', version: '1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 10_000);
          if (init?.protocolVersion !== 1) throw failure('ACP_PROTOCOL_ERROR');
          const session = await channel.request('session/new', { cwd, mcpServers: [] }, 10_000);
          sessionId = session?.sessionId;
          if (typeof sessionId !== 'string' || !sessionId) throw failure('ACP_PROTOCOL_ERROR');
          const options = [{ id: 'model', value: snapshot.alias }, ...(declaration.sessionConfig?.(snapshot, selected.selected) ?? [])];
          if (options.length > 8 || new Set(options.map(option => option.id)).size !== options.length) throw failure('ACP_PROTOCOL_ERROR');
          for (const option of options) {
            if (typeof option.id !== 'string' || typeof option.value !== 'string'
                || !session.configOptions?.some(offered => offered.id === option.id && offered.options?.some(value => value.value === option.value))) throw failure('ACP_PROTOCOL_ERROR');
            await channel.request('session/set_config_option', { sessionId, configId: option.id, value: option.value }, 10_000);
          }
          callStarted = true;
          const result = await channel.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, 75_000);
          if (result?.stopReason !== 'end_turn') throw failure();
          const chunks = [];
          for (const event of channel.messages) {
            if (event?.sessionId !== sessionId) throw failure('ACP_PROTOCOL_ERROR');
            const update = event.update;
            if (update?.sessionUpdate === 'agent_message_chunk') {
              if (update.content?.type !== 'text' || typeof update.content.text !== 'string') throw failure('ACP_PROTOCOL_ERROR');
              chunks.push(update.content.text);
            }
          }
          answer = chunks.join('');
          if (!answer.trim()) throw failure();
        } finally { clearTimeout(timer); }
      } catch (error) { thrown = error; }
      finally {
        if (channel) {
          safeToRemove = await channel.dispose(sessionId);
          if (!safeToRemove) thrown = channel.cleanupFailure();
          else if (!thrown && (channel.error || channel.nativeResult?.code !== 0 || channel.nativeResult?.failure)) thrown = channel.error ?? failure();
          else if (!thrown && channel.messages.some(event => event?.sessionId !== sessionId)) thrown = failure('ACP_PROTOCOL_ERROR');
        }
        if (safeToRemove) {
          try { if (!thrown) { facts = nativeFacts(declaration, home); validateFacts(facts, selected.route); } }
          catch { thrown = failure(); }
        }
        if (channel) {
          if (!await channel.release()) thrown = channel.cleanupFailure();
          else if (!thrown && channel.guardianResult?.code !== 0) thrown = failure();
        } else if (safeToRemove) {
          try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
          catch { thrown = failure('ACP_CLEANUP_FAILED'); }
        }
      }
      if (thrown) {
        if (!callStarted && thrown.code !== 'MODEL_UNAVAILABLE' && thrown.code !== 'ABORT_ERR' && thrown.code !== 'ACP_CLEANUP_FAILED') throw new ModelUnavailable('unsafe_runtime');
        throw thrown;
      }
      if (signal?.aborted) throw failure('ABORT_ERR');
      return { answer, ...(facts?.usage ? { usage: facts.usage } : {}) };
    },
  };
}

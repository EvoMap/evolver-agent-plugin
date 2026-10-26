// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runProcess } from '../process/spawn.js';
import { runningProxy } from '../proxy.js';
import { versionOf } from '../../engine/version.js';

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const LIFECYCLE_TIMEOUT_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 10 * 1000;
const PROXY_WAIT_MS = 60 * 1000;
const PROXY_POLL_MS = 1000;
const ERROR_MAX_CHARS = 300;
const PACKAGE = '@evomap/evolver';
const IS_WINDOWS = process.platform === 'win32';

function run(command, args, { timeoutMs, env, shim = false }) {
  return runProcess(command, args, { timeoutMs, env, shim }).then((result) => ({
    ok: result.code === 0,
    stdout: result.stdout,
    error: result.code === 0 ? null : String(result.stderr || result.error?.message || `exit ${result.code}`).trim().slice(-ERROR_MAX_CHARS),
    missing: result.error?.code === 'ENOENT',
  }));
}

// Evolver's first start otherwise migrates itself to a standalone binary and
// registers a launchd/systemd/scheduled-task service, which a plugin must not
// do on the person's behalf; an explicit setting of theirs still wins.
function lifecycleEnv() {
  return { ...process.env, EVOLVER_SELF_UPDATE: process.env.EVOLVER_SELF_UPDATE || 'off' };
}

function bundledNpmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = IS_WINDOWS
    ? [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function defaultNpmCommand() {
  const cli = bundledNpmCli();
  return cli ? { command: process.execPath, args: [cli], shim: false } : { command: 'npm', args: [], shim: true };
}

function managedPackageDir(prefix) {
  return path.join(prefix, 'node_modules', ...PACKAGE.split('/'));
}

function managedEngineAt(prefix) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(managedPackageDir(prefix), 'package.json'), 'utf8'));
    const binPath = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.evolver;
    const entry = path.join(managedPackageDir(prefix), binPath);
    if (!versionOf(manifest.version) || !fs.existsSync(entry)) return null;
    return {
      source: 'managed',
      path: entry,
      version: versionOf(manifest.version),
      run: (args) => run(process.execPath, [entry, ...args], { timeoutMs: LIFECYCLE_TIMEOUT_MS, env: lifecycleEnv() }),
    };
  } catch {
    return null;
  }
}

async function pathEngine() {
  const probe = await run('evolver', ['--version'], { timeoutMs: PROBE_TIMEOUT_MS, env: process.env, shim: true });
  const version = probe.ok ? versionOf(probe.stdout) : null;
  if (!version) return null;
  return {
    source: 'path',
    path: 'evolver',
    version,
    run: (args) => run('evolver', args, { timeoutMs: LIFECYCLE_TIMEOUT_MS, env: lifecycleEnv(), shim: true }),
  };
}

async function waitForProxy(deadlineMs, isWanted) {
  const deadline = Date.now() + deadlineMs;
  let seen = null;
  while (Date.now() < deadline) {
    seen = await runningProxy();
    if (seen && isWanted(seen)) return seen;
    await new Promise((resolve) => setTimeout(resolve, PROXY_POLL_MS));
  }
  return seen;
}

export function engineRuntime({ prefix, npm = defaultNpmCommand(), proxyWaitMs = PROXY_WAIT_MS } = {}) {
  return {
    nodeVersion: process.versions.node,
    now: () => Date.now(),
    managedEngine: async () => managedEngineAt(prefix),
    pathEngine,
    runningProxy,
    waitForProxy: (isWanted = () => true) => waitForProxy(proxyWaitMs, isWanted),
    installLatest: () => {
      fs.mkdirSync(prefix, { recursive: true });
      const args = [...npm.args, 'install', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error', `${PACKAGE}@latest`];
      return run(npm.command, args, { timeoutMs: INSTALL_TIMEOUT_MS, env: process.env, shim: npm.shim });
    },
  };
}

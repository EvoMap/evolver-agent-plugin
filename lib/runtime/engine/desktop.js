// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

import { meetsMinimum } from '../../engine/version.js';
import { nodeExecutable } from '../process/node.js';

const SCHEMA = 'evolver.desktop.plugin-engine.v1';
const VERSION = /^2\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-beta\.(0|[1-9][0-9]*))?$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const REPAIR = 'The Evolver Desktop installation could not be verified. Repair Evolver and reinstall the Codex plugin in EvoMap Desktop.';
const NATIVE_BINARIES = ['evolver-darwin-arm64', 'evolver-darwin-x64', 'evolver-linux-arm64', 'evolver-linux-x64', 'evolver-windows-x64.exe'];
const NATIVE_KEY = createPublicKey({
  key: Buffer.from('MCowBQYDK2VwAyEAebNxmtdPCjYpeRaFbmay4Y3/GY28tB4/hwFEXZrgeoE=', 'base64'),
  type: 'spki',
  format: 'der',
});

const repairError = () => Object.assign(new Error(REPAIR), { source: 'desktop' });

export function desktopHomeOf(env) {
  // Desktop's Go installer uses USERPROFILE on Windows and HOME on Unix.
  return (process.platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME) || homedir();
}

function nativeBinary() {
  const { platform, arch } = process;
  if (arch !== 'x64' && arch !== 'arm64') return null;
  if (platform === 'win32') return 'evolver-windows-x64.exe';
  if (platform === 'darwin' || platform === 'linux') return `evolver-${platform}-${arch}`;
  return null;
}

function regularFile(file, limit) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw new Error(REPAIR);
  if (path.relative(file, fs.realpathSync.native(file)) !== '') {
    // Windows expands short file names even when the path has no junction or symlink.
    if (process.platform !== 'win32') throw new Error(REPAIR);
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
      if (!fs.lstatSync(parent).isDirectory()) throw new Error(REPAIR);
      if (path.dirname(parent) === parent) break;
    }
  }
  return stat;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function jsonFile(file) {
  const before = regularFile(file, MAX_RECORD_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    if (!sameFile(before, fs.fstatSync(fd))) throw new Error(REPAIR);
    const bytes = Buffer.alloc(before.size);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error(REPAIR);
    if (!sameFile(before, regularFile(file, MAX_RECORD_BYTES))) throw new Error(REPAIR);
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function optionalJson(file) {
  try {
    return jsonFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function verifyDigest(binary, digest) {
  try {
    const before = regularFile(binary, MAX_BINARY_BYTES);
    const file = await fs.promises.open(binary, 'r');
    try {
      if (!sameFile(before, await file.stat())) throw new Error(REPAIR);
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false, end: before.size - 1 })) hash.update(chunk);
      if (hash.digest('hex') !== digest || !sameFile(before, regularFile(binary, MAX_BINARY_BYTES))) throw new Error(REPAIR);
    } finally {
      await file.close();
    }
  } catch {
    throw repairError();
  }
}

function npmBin(root, { prefix, version }) {
  if (typeof prefix !== 'string' || (prefix !== '.' && !/^npm-[a-zA-Z0-9-]+$/.test(prefix))) throw new Error(REPAIR);
  const pkg = path.join(root, prefix, 'node_modules', '@evomap', 'evolver');
  const manifest = jsonFile(path.join(pkg, 'package.json'));
  const bin = manifest?.bin?.evolver;
  if (manifest?.name !== '@evomap/evolver' || manifest.version !== version || typeof bin !== 'string' || path.isAbsolute(bin) || bin.includes(':')) throw new Error(REPAIR);
  const entry = path.join(pkg, bin);
  const relative = path.relative(pkg, entry);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error(REPAIR);
  regularFile(entry, MAX_BINARY_BYTES);
  return entry;
}

function npmProxyBins(root, entry) {
  try {
    const binary = createRequire(entry).resolve('@evomap/evolver-proxy/bin/evolver-proxy');
    const rel = path.relative(root, binary);
    if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) return [];
    regularFile(binary, MAX_BINARY_BYTES);
    return [binary];
  } catch {
    return [];
  }
}

function verifyManifest(manifest, version, key) {
  if (manifest?.schemaVersion !== 1 || manifest.version !== version || manifest.signatureAlg !== 'ed25519' ||
      !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== NATIVE_BINARIES.length ||
      typeof manifest.signature !== 'string') throw new Error(REPAIR);
  const artifacts = NATIVE_BINARIES.map((name) => {
    const asset = manifest.artifacts.find((candidate) => candidate?.path === name);
    if (typeof asset?.sha256 !== 'string' || !DIGEST.test(asset.sha256) ||
        !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_BINARY_BYTES ||
        asset.downloadUrl !== `https://github.com/EvoMap/evolver/releases/download/v${version}/${name}`) throw new Error(REPAIR);
    return { path: name, sha256: asset.sha256 };
  });
  // Desktop signs the version and sorted artifact path/digest pairs in this exact field order.
  const signature = Buffer.from(manifest.signature, 'base64');
  const payload = Buffer.from(JSON.stringify({ version, artifacts }));
  if (signature.length !== 64 || signature.toString('base64') !== manifest.signature || !verify(null, payload, key, signature)) throw new Error(REPAIR);
  return artifacts;
}

/** Resolves only the pinned installation recorded by EvoMap Desktop in the user's profile. */
export function desktopEngineOf(home = homedir(), nativeKey = NATIVE_KEY) {
  if (!path.isAbsolute(home)) return null;
  const root = path.join(home, '.evomap-desktop', 'tools', 'evolver');
  const record = path.join(root, 'plugin-engine.json');
  try {
    fs.lstatSync(record);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw repairError();
  }
  try {
    const selection = jsonFile(record);
    const { kind, version, digest, legacy } = selection;
    if (selection.schema !== SCHEMA || typeof version !== 'string' || !VERSION.test(version) || !meetsMinimum(version)) throw new Error(REPAIR);
    const npm = optionalJson(path.join(root, 'npm-install.json'));
    if (kind === 'npm') {
      if (selection.prefix === '.') {
        if (npm !== undefined || optionalJson(path.join(root, 'native-install.json')) !== undefined) throw new Error(REPAIR);
      } else if (npm?.schema !== 'evolver.npm.install.v1' || npm.prefix !== selection.prefix) {
        throw new Error(REPAIR);
      }
      const entry = npmBin(root, selection);
      return { command: nodeExecutable(), args: [entry], version, proxyBins: () => npmProxyBins(path.join(root, selection.prefix), entry) };
    }
    const name = nativeBinary();
    if (kind !== 'native' || !name || typeof digest !== 'string' || !DIGEST.test(digest) || (legacy !== undefined && legacy !== true) || npm !== undefined) throw new Error(REPAIR);
    const installed = jsonFile(path.join(root, 'native-install.json'));
    if (installed?.schema !== 'evolver.native.install.v1' || installed.version !== version || installed.binary !== name ||
        (legacy ? Boolean(installed.digest) : installed.digest !== digest)) throw new Error(REPAIR);
    const artifact = verifyManifest(installed.manifest, version, nativeKey).find(({ path }) => path === name);
    if (artifact.sha256 !== digest) throw new Error(REPAIR);
    const binary = path.join(root, 'native', version, ...(legacy ? [] : [digest]), name);
    regularFile(binary, MAX_BINARY_BYTES);
    return { command: binary, args: [], version, verify: () => verifyDigest(binary, digest) };
  } catch {
    throw repairError();
  }
}

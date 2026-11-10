// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The Node.js to run a script with. In a host that runs its plugins on another runtime (OpenCode on Bun),
// `process.execPath` is the host's own binary, which cannot start Evolver or a worker; the `node` on PATH can.
export function nodeExecutable({ execPath = process.execPath, versions = process.versions } = {}) {
  return versions.bun ? 'node' : execPath;
}

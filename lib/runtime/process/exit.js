// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

export function exitProcess(code, { drainWindowsHandles, stdin } = {}) {
  if (process.platform !== 'win32' || !drainWindowsHandles) process.exit(code);
  stdin?.unref?.();
  process.exitCode = code;
}

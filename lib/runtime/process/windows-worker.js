// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const LAUNCH_TIMEOUT_MS = 2_000;
// Avoid PowerShell startup in the hook budget; Node's detached spawn inherits extra Windows pipe handles.
const LAUNCH = String.raw`using System;
using System.Runtime.InteropServices;
using System.Text;
public static class EvolverWindowsWorker {
  [StructLayout(LayoutKind.Sequential)] struct Startup {
    public int Size;
    public IntPtr Reserved, Desktop, Title;
    public int X, Y, Width, Height, XChars, YChars, Fill, Flags;
    public short Show, ReservedSize;
    public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct Info { public IntPtr Process, Thread; public uint Pid, Tid; }
  [DllImport("kernel32.dll", EntryPoint="CreateProcessW", CharSet=CharSet.Unicode, ExactSpelling=true)]
  static extern bool CreateProcess(string application, StringBuilder line, IntPtr processSecurity, IntPtr threadSecurity,
    bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out Info info);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Main() {
    try {
      string encoded = Environment.GetEnvironmentVariable("EVOLVER_WINDOWS_WORKER");
      Environment.SetEnvironmentVariable("EVOLVER_WINDOWS_WORKER", null);
      string[] parts = Encoding.Unicode.GetString(Convert.FromBase64String(encoded)).Split('\0');
      if (parts.Length != 3) return 1;
      Startup startup = new Startup(); startup.Size = Marshal.SizeOf(typeof(Startup));
      Info info;
      // CREATE_NO_WINDOW, no inherited handles, and no breakaway from the host's job.
      if (!CreateProcess(parts[0], new StringBuilder(parts[1]), IntPtr.Zero, IntPtr.Zero, false, 0x08000000,
          IntPtr.Zero, parts[2], ref startup, out info)) return 1;
      try { Console.WriteLine(info.Pid); Console.Out.Flush(); }
      finally { CloseHandle(info.Thread); CloseHandle(info.Process); }
      return 0;
    } catch { return 1; }
  }
}`;

export function startWithoutInheritedHandles(systemDirectory, executable, commandLine, { cwd, env, run = spawnSync }) {
  if (!systemDirectory || !path.isAbsolute(systemDirectory) || !path.isAbsolute(executable)) return undefined;
  let scratch;
  try {
    scratch = mkdtempSync(path.join(tmpdir(), 'evolver-win-worker-'));
    const source = path.join(scratch, 'worker.cs');
    const bridge = path.join(scratch, 'worker.exe');
    writeFileSync(source, LAUNCH, { mode: 0o600, flag: 'wx' });
    const compiler = path.join(path.dirname(systemDirectory), 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
    const started = performance.now();
    const compiled = run(compiler, ['/nologo', '/noconfig', '/target:exe', '/out:' + bridge, source], {
      cwd: scratch, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: LAUNCH_TIMEOUT_MS,
    });
    const remaining = Math.floor(LAUNCH_TIMEOUT_MS - (performance.now() - started));
    if (compiled.error || compiled.status !== 0 || remaining <= 0) return undefined;
    const spec = Buffer.from([executable, commandLine, cwd].join('\0'), 'utf16le').toString('base64');
    const result = run(bridge, [], {
      cwd, env: { ...env, EVOLVER_WINDOWS_WORKER: spec },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: remaining,
    });
    if (result.error?.code !== 'ETIMEDOUT' && (result.error || result.status !== 0)) return undefined;
    // A complete PID line confirms creation even if the bridge times out after flushing it.
    const pid = /^([1-9]\d{0,9})\r?\n$/.exec(result.stdout ?? '')?.[1];
    return pid ? Number(pid) : undefined;
  } catch { return undefined; }
  finally {
    if (scratch) try { rmSync(scratch, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 }); } catch { }
  }
}

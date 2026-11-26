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
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct Info { public IntPtr Process, Thread; public uint Pid, Tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimits Basic;
    public ulong Reads, Writes, Others, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, int size);
  [DllImport("kernel32.dll")] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll")] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", EntryPoint="CreateProcessW", CharSet=CharSet.Unicode, ExactSpelling=true)]
  static extern bool CreateProcess(string application, StringBuilder line, IntPtr processSecurity, IntPtr threadSecurity,
    bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out Info info);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Main() {
    IntPtr job = IntPtr.Zero;
    Info info = new Info();
    try {
      string encoded = Environment.GetEnvironmentVariable("EVOLVER_WINDOWS_WORKER");
      Environment.SetEnvironmentVariable("EVOLVER_WINDOWS_WORKER", null);
      string[] parts = Encoding.Unicode.GetString(Convert.FromBase64String(encoded)).Split('\0');
      if (parts.Length != 3) return 1;
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) return 1;
      var limits = new Limits { Basic = new BasicLimits { Flags = 0x2000 } }; // KILL_ON_JOB_CLOSE until acknowledgement.
      if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(Limits)))) return 1;
      IntPtr size = IntPtr.Zero, attributes = IntPtr.Zero, value = IntPtr.Zero;
      bool initialized = false;
      try {
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        if (size == IntPtr.Zero) return 1;
        attributes = Marshal.AllocHGlobal(size);
        value = Marshal.AllocHGlobal(IntPtr.Size);
        if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) return 1;
        initialized = true;
        Marshal.WriteIntPtr(value, job);
        // JOB_LIST closes the creation-to-assignment race if the launcher times out.
        if (!UpdateProcThreadAttribute(attributes, 0, (UIntPtr)0x2000du, value, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) return 1;
        var startup = new StartupEx { Startup = new Startup { Size = Marshal.SizeOf(typeof(StartupEx)) }, Attributes = attributes };
        // CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT; no inherited handles or host-job breakaway.
        if (!CreateProcess(parts[0], new StringBuilder(parts[1]), IntPtr.Zero, IntPtr.Zero, false, 0x08080000,
            IntPtr.Zero, parts[2], ref startup, out info)) return 1;
      } finally {
        if (initialized) DeleteProcThreadAttributeList(attributes);
        Marshal.FreeHGlobal(value); Marshal.FreeHGlobal(attributes);
      }
      Console.WriteLine(info.Pid); Console.Out.Flush();
      // Release the guard without adding a breakaway restriction to the host's existing job chain.
      limits.Basic.Flags = 0x800;
      if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(Limits)))) return 1;
      return 0;
    } catch { return 1; }
    finally {
      if (info.Thread != IntPtr.Zero) CloseHandle(info.Thread);
      if (info.Process != IntPtr.Zero) CloseHandle(info.Process);
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}`;

export function startWithoutInheritedHandles(systemDirectory, executable, commandLine, { cwd, env, run = spawnSync, onUnconfirmed }) {
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
    // Retain creation identity on timeout, but do not confirm that guard handoff completed.
    const pid = /^([1-9]\d{0,9})\r?\n$/.exec(result.stdout ?? '')?.[1];
    if (!pid) return undefined;
    // A diagnostic callback must not make us lose track of a possibly live worker.
    try { if (result.error) onUnconfirmed?.(); } catch { }
    return Number(pid);
  } catch { return undefined; }
  finally {
    if (scratch) try { rmSync(scratch, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 }); } catch { }
  }
}

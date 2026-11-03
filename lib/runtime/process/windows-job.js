// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// Windows PowerShell ships with the OS. Compile the small Win32 bridge inside owned scratch.
const SCRIPT = String.raw`param([string] $SpecPath)
$ErrorActionPreference = 'Stop'
$key = [Environment]::GetEnvironmentVariable('EVOLVER_MODEL_API_KEY', 'Process')
[Environment]::SetEnvironmentVariable('EVOLVER_MODEL_API_KEY', $null, 'Process')
try {
  $spec = Get-Content -LiteralPath $SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public sealed class EvolverJob {
  [StructLayout(LayoutKind.Sequential)] struct Security { public int Size; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential)] struct Startup {
    public int Size;
    public IntPtr Reserved, Desktop, Title;
    public int X, Y, Width, Height, XChars, YChars, Fill, Flags;
    public short Show, ReservedSize;
    public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
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
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint Faults, Total, Active, Terminated;
  }

  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, int size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, IntPtr size, IntPtr oldValue, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);

  static void Check(bool ok) { if (!ok) throw new Win32Exception(); }
  static void Close(IntPtr handle) { if (handle != IntPtr.Zero) CloseHandle(handle); }
  static void Proof(string line) { Console.Error.WriteLine(line); Console.Error.Flush(); }

  sealed class Pipe : IDisposable {
    public IntPtr Child;
    public FileStream Parent;
    public Pipe(bool input) {
      var security = new Security { Size = Marshal.SizeOf(typeof(Security)), Inherit = 1 };
      IntPtr read, write;
      Check(CreatePipe(out read, out write, ref security, 0));
      Child = input ? read : write;
      var parent = new SafeFileHandle(input ? write : read, true);
      try {
        Check(SetHandleInformation(parent.DangerousGetHandle(), 1, 0));
        Parent = new FileStream(parent, input ? FileAccess.Write : FileAccess.Read);
      } catch { parent.Dispose(); CloseChild(); throw; }
    }
    public void CloseChild() { Close(Child); Child = IntPtr.Zero; }
    public void Dispose() { CloseChild(); Parent.Dispose(); }
  }

  // Quote for CommandLineToArgvW/CRT parsing, not cmd.exe or PowerShell.
  static string Quote(string value) {
    var result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      result.Append('\\', c == '"' ? 2 * slashes + 1 : slashes).Append(c);
      slashes = 0;
    }
    return result.Append('\\', 2 * slashes).Append('"').ToString();
  }

  static ProcessInfo Launch(IntPtr job, string command, string[] args, string cwd, Pipe input, Pipe output, Pipe error) {
    var size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
    Check(size != IntPtr.Zero);
    var attributes = Marshal.AllocHGlobal(size);
    var values = Marshal.AllocHGlobal(IntPtr.Size * 4);
    bool initialized = false;
    try {
      Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size));
      initialized = true;
      Marshal.WriteIntPtr(values, 0, input.Child);
      Marshal.WriteIntPtr(values, IntPtr.Size, output.Child);
      Marshal.WriteIntPtr(values, IntPtr.Size * 2, error.Child);
      Marshal.WriteIntPtr(values, IntPtr.Size * 3, job);
      Check(UpdateProcThreadAttribute(attributes, 0, (UIntPtr)0x20002u, values, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero));
      // JOB_LIST assigns the job atomically at creation, even if this launcher dies before ResumeThread.
      Check(UpdateProcThreadAttribute(attributes, 0, (UIntPtr)0x2000du, IntPtr.Add(values, IntPtr.Size * 3), (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero));
      var startup = new StartupEx { Startup = new Startup { Size = Marshal.SizeOf(typeof(StartupEx)), Flags = 0x100, Input = input.Child, Output = output.Child, Error = error.Child }, Attributes = attributes };
      var line = new StringBuilder(Quote(command));
      foreach (string arg in args ?? new string[0]) line.Append(' ').Append(Quote(arg));
      ProcessInfo process;
      // EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_SUSPENDED
      Check(CreateProcess(command, line, IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, cwd, ref startup, out process));
      return process;
    } finally {
      if (initialized) DeleteProcThreadAttributeList(attributes);
      Marshal.FreeHGlobal(values);
      Marshal.FreeHGlobal(attributes);
      input.CloseChild(); output.CloseChild(); error.CloseChild();
    }
  }

  static uint Active(IntPtr job) {
    Accounting accounting;
    Check(QueryInformationJobObject(job, 1, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
    return accounting.Active;
  }

  static Thread Background(ThreadStart action) {
    var worker = new Thread(action) { IsBackground = true };
    worker.Start();
    return worker;
  }

  readonly BlockingCollection<byte[]> input = new BlockingCollection<byte[]>(4);
  int stop, eof;
  long bytes;

  void Ingress() {
    try {
      var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true), false);
      for (string line = reader.ReadLine(); line != null; line = reader.ReadLine()) {
        if (!input.TryAdd(Encoding.UTF8.GetBytes(line + "\n"))) { Interlocked.CompareExchange(ref stop, 2, 0); break; }
      }
    } catch { Interlocked.CompareExchange(ref stop, 2, 0); }
    finally { input.CompleteAdding(); Volatile.Write(ref eof, 1); }
  }

  void Feed(Stream destination) {
    try {
      using (destination) foreach (var line in input.GetConsumingEnumerable()) { destination.Write(line, 0, line.Length); destination.Flush(); }
    } catch (IOException) { /* The native process may close stdin before it exits. */ }
      catch (ObjectDisposedException) { /* Job exit closes our input handle too. */ }
  }

  void Drain(Stream source, Stream destination) {
    try {
      var buffer = new byte[8192];
      for (int size = source.Read(buffer, 0, buffer.Length); size > 0; size = source.Read(buffer, 0, buffer.Length)) {
        if (Interlocked.Add(ref bytes, size) > 16 * 1024 * 1024) { Interlocked.CompareExchange(ref stop, 1, 0); break; }
        if (destination != null) { destination.Write(buffer, 0, size); destination.Flush(); }
      }
    } catch { Interlocked.CompareExchange(ref stop, 2, 0); }
  }

  public int Run(string command, string[] args, string cwd, string stopFile, string key) {
    IntPtr job = IntPtr.Zero;
    ProcessInfo native = new ProcessInfo();
    try {
      if (File.Exists(stopFile)) { Proof("D 0 cancelled"); return 0; }
      job = CreateJobObject(IntPtr.Zero, null);
      Check(job != IntPtr.Zero);
      var limits = new Limits { Basic = new BasicLimits { Flags = 0x2000 } }; // KILL_ON_JOB_CLOSE, no breakaway.
      Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(Limits))));
      using (var inputPipe = new Pipe(true))
      using (var outputPipe = new Pipe(false))
      using (var errorPipe = new Pipe(false)) {
        Environment.SetEnvironmentVariable("EVOLVER_MODEL_API_KEY", key);
        try { native = Launch(job, command, args, cwd, inputPipe, outputPipe, errorPipe); }
        finally { Environment.SetEnvironmentVariable("EVOLVER_MODEL_API_KEY", null); }
        Proof("S " + native.Pid);
        var output = Background(() => Drain(outputPipe.Parent, Console.OpenStandardOutput()));
        var error = Background(() => Drain(errorPipe.Parent, null));
        Background(Ingress);
        Background(() => Feed(inputPipe.Parent));
        string failure = "ok";
        uint code = 0;
        if (!File.Exists(stopFile)) {
          Check(ResumeThread(native.Thread) != uint.MaxValue);
          Stopwatch eofTime = null;
          for (;;) {
            var status = WaitForSingleObject(native.Process, 25);
            if (status == 0) { Check(GetExitCodeProcess(native.Process, out code)); break; }
            Check(status == 258);
            if (File.Exists(stopFile)) { failure = "cancelled"; break; }
            var stopped = Volatile.Read(ref stop);
            if (stopped != 0) { failure = stopped == 1 ? "output_limit" : "bridge_failed"; break; }
            if (Volatile.Read(ref eof) != 0) {
              if (eofTime == null) eofTime = Stopwatch.StartNew();
              if (eofTime.ElapsedMilliseconds >= 5000) { failure = "shutdown_timeout"; break; }
            }
          }
        } else failure = "cancelled";

        // Native root exit is not a job exit; descendants can still hold pipe handles.
        if (Active(job) != 0 && !TerminateJobObject(job, 1)) Check(Active(job) == 0);
        var closing = Stopwatch.StartNew();
        while (Active(job) != 0) { if (closing.ElapsedMilliseconds >= 1000) return 1; Thread.Sleep(10); }
        if (!output.Join(1000) || !error.Join(1000)) return 1;
        if (failure == "ok" && Volatile.Read(ref stop) != 0) failure = stop == 1 ? "output_limit" : "bridge_failed";
        Proof("D " + code + " " + failure);
        return 0;
      }
    } catch (Win32Exception error) {
      if (native.Process == IntPtr.Zero) { Proof("D 0 spawn_failed"); return 0; }
      Proof("E " + error.NativeErrorCode);
      return 1;
    } finally { Close(job); Close(native.Thread); Close(native.Process); }
  }
}
'@
} catch {
  [Console]::Error.WriteLine('D 0 spawn_failed')
  exit 0
}
try {
  $job = [EvolverJob]::new()
  exit $job.Run([string] $spec.command, [string[]] $spec.args, [string] $spec.cwd, [string] $spec.stopFile, $key)
} catch {
  [Console]::Error.WriteLine('E bridge_failed')
  exit 1
}
`;

/** The helper's stderr is control only; native stderr is drained and counted inside the job. */
export function startWindowsJob(spec, onNative) {
  const root = process.env.SystemRoot || process.env.WINDIR;
  if (!root || !isAbsolute(root) || !isAbsolute(spec.command)) throw new Error('Windows job launcher needs absolute executable paths');
  const script = join(spec.home, '.evolver-job.ps1'), config = join(spec.home, '.evolver-job.json'), stopFile = join(spec.home, '.evolver-job-stop');
  const data = JSON.stringify({ command: spec.command, args: spec.args, cwd: spec.cwd, stopFile });
  if (process.env.EVOLVER_MODEL_API_KEY && data.includes(process.env.EVOLVER_MODEL_API_KEY)) throw new Error('Unsafe Windows job configuration');
  writeFileSync(script, SCRIPT, { flag: 'wx', mode: 0o600 });
  writeFileSync(config, data, { flag: 'wx', mode: 0o600 });
  const child = spawn(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-SpecPath', config], { cwd: spec.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', invalid = false, nativePid, result;
  child.stderr.on('data', chunk => {
    if (invalid) return;
    buffer += chunk.toString('ascii');
    if (buffer.length > 2048) { invalid = true; return; }
    for (let end; (end = buffer.indexOf('\n')) !== -1;) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      const started = /^S ([1-9]\d{0,9})$/.exec(line);
      const done = /^D (\d{1,10}) (ok|cancelled|output_limit|shutdown_timeout|bridge_failed|spawn_failed)$/.exec(line);
      if (started && !nativePid && !result && Number(started[1]) <= 0xffffffff) { nativePid = Number(started[1]); onNative(nativePid); }
      else if (done && !result && (nativePid || ['cancelled', 'spawn_failed'].includes(done[2])) && Number(done[1]) <= 0xffffffff) result = { code: Number(done[1]), failure: done[2] === 'ok' ? undefined : done[2] };
      else { invalid = true; return; }
    }
  });
  return {
    child,
    stop() {
      try { writeFileSync(stopFile, '', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
    },
    proof(code, signal) { return !invalid && !buffer && code === 0 && signal === null ? result : undefined; },
  };
}

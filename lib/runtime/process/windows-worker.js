// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Node's detached spawn can leave extra inheritable handles open under Windows PowerShell.
const LAUNCH = Buffer.from(String.raw`$ErrorActionPreference = 'Stop'
$spec = $env:EVOLVER_WINDOWS_WORKER | ConvertFrom-Json
Remove-Item Env:EVOLVER_WINDOWS_WORKER
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
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

    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr Process, Thread;
        public uint Pid, Tid;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateProcessW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processSecurity, IntPtr threadSecurity,
        bool inheritHandles, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo info);

    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    public static uint Start(string application, string commandLine, string cwd) {
        var startup = new Startup { Size = Marshal.SizeOf(typeof(Startup)) };
        ProcessInfo info;
        // CREATE_NO_WINDOW. Keep the child in the host's Windows job and discard its inherited pipe handles.
        if (!CreateProcess(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, 0x08000000,
            IntPtr.Zero, cwd, ref startup, out info)) throw new Win32Exception();
        CloseHandle(info.Thread);
        CloseHandle(info.Process);
        return info.Pid;
    }
}
'@
[EvolverWindowsWorker]::Start($spec.executable, $spec.commandLine, $spec.cwd)
`, 'utf16le').toString('base64');

export function startWithoutInheritedHandles(systemDirectory, executable, commandLine, { cwd, env }) {
  if (!systemDirectory || !path.isAbsolute(executable)) return undefined;
  const powershell = path.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', LAUNCH], {
    cwd, env: { ...env, EVOLVER_WINDOWS_WORKER: JSON.stringify({ executable, commandLine, cwd }) },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 2_000,
  });
  const pid = result.stdout?.trim();
  return !result.error && result.status === 0 && /^[1-9]\d{0,9}$/.test(pid) ? Number(pid) : undefined;
}

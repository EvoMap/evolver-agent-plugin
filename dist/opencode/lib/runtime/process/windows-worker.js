// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Node's detached spawn can leave extra inheritable handles open under Windows PowerShell.
const LAUNCH = Buffer.from(String.raw`$ErrorActionPreference = 'Stop'
$parts = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:EVOLVER_WINDOWS_WORKER)).Split([char]0)
[Environment]::SetEnvironmentVariable('EVOLVER_WINDOWS_WORKER', [NullString]::Value)
if ($parts.Length -ne 3) { throw 'Invalid Evolver worker arguments' }
# Emit P/Invoke declarations in memory. A cold Add-Type compile can consume Codex's three-second hook budget.
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('EvolverWindowsWorker'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$type = $assembly.DefineDynamicModule('EvolverWindowsWorker').DefineType('EvolverWindowsWorker', [Reflection.TypeAttributes]'Public, Sealed, Abstract')
$attributes = [Reflection.MethodAttributes]'Public, Static, PinvokeImpl'
$calling = [Reflection.CallingConventions]::Standard
$winapi = [Runtime.InteropServices.CallingConvention]::Winapi
$unicode = [Runtime.InteropServices.CharSet]::Unicode
$create = $type.DefinePInvokeMethod('CreateProcess', 'kernel32.dll', 'CreateProcessW', $attributes, $calling, [bool],
    [Type[]]@([string], [Text.StringBuilder], [IntPtr], [IntPtr], [bool], [uint32], [IntPtr], [string], [IntPtr], [IntPtr]), $winapi, $unicode)
$close = $type.DefinePInvokeMethod('CloseHandle', 'kernel32.dll', $attributes, $calling, [bool], [Type[]]@([IntPtr]), $winapi, $unicode)
foreach ($method in @($create, $close)) {
    $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
}
$native = $type.CreateType()
$pointerSize = [IntPtr]::Size
# STARTUPINFOW is zero-initialized except for cb. PROCESS_INFORMATION is two handles followed by two DWORDs.
$startupSize = if ($pointerSize -eq 8) { 104 } else { 68 }
$startupBytes = [byte[]]::new($startupSize)
$processBytes = [byte[]]::new(2 * $pointerSize + 8)
[BitConverter]::GetBytes([int]$startupSize).CopyTo($startupBytes, 0)
$startup = [Runtime.InteropServices.GCHandle]::Alloc($startupBytes, [Runtime.InteropServices.GCHandleType]::Pinned)
$process = [Runtime.InteropServices.GCHandle]::Alloc($processBytes, [Runtime.InteropServices.GCHandleType]::Pinned)
try {
    $processInfo = $process.AddrOfPinnedObject()
    # CREATE_NO_WINDOW keeps the worker hidden. The child stays in the host's job and inherits no pipe handles.
    if (!$native::CreateProcess($parts[0], [Text.StringBuilder]::new($parts[1]), [IntPtr]::Zero, [IntPtr]::Zero,
        $false, 0x08000000, [IntPtr]::Zero, $parts[2], $startup.AddrOfPinnedObject(), $processInfo)) {
        throw 'Could not start the Evolver worker'
    }
    [Console]::WriteLine([BitConverter]::ToUInt32($processBytes, 2 * $pointerSize))
    [Console]::Out.Flush()
    [void]$native::CloseHandle([Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo, $pointerSize))
    [void]$native::CloseHandle([Runtime.InteropServices.Marshal]::ReadIntPtr($processInfo))
} finally {
    $process.Free()
    $startup.Free()
}
`, 'utf16le').toString('base64');

export function startWithoutInheritedHandles(systemDirectory, executable, commandLine, { cwd, env, run = spawnSync }) {
  if (!systemDirectory || !path.isAbsolute(executable)) return undefined;
  const powershell = path.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const spec = Buffer.from([executable, commandLine, cwd].join('\0'), 'utf16le').toString('base64');
  const result = run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', LAUNCH], {
    cwd, env: { ...env, EVOLVER_WINDOWS_WORKER: spec },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 2_000,
  });
  if (result.error?.code !== 'ETIMEDOUT' && (result.error || result.status !== 0)) return undefined;
  // The helper can time out after CreateProcessW succeeds. Its complete PID line confirms that launch.
  const pid = /^([1-9]\d{0,9})\r?\n$/.exec(result.stdout ?? '')?.[1];
  return pid ? Number(pid) : undefined;
}

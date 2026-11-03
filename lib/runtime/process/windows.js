// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';

/** A bounded ancestor snapshot, without command lines or credentials; an unavailable process table stays unknown. */
export function windowsAncestorsOf(pid, { run = spawnSync, env = process.env } = {}) {
  const empty = () => new Map();
  const root = env.SystemRoot || env.WINDIR || '';
  if (!Number.isSafeInteger(pid) || pid <= 0 || !win32.isAbsolute(root)) return empty();
  // One CIM snapshot avoids a new WMI round trip for each shell or ancestor; only the bounded chain leaves PowerShell.
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $evolverTable=@{}; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath | ForEach-Object {$evolverTable[[int]$_.ProcessId]=$_}; $evolverPid=${pid}; $evolverRows=@(); for($evolverDepth=0;$evolverDepth -lt 16 -and $evolverPid -gt 0;$evolverDepth++){ $p=$evolverTable[$evolverPid]; if($null -eq $p){break}; $evolverRows += [pscustomobject]@{pid=[int]$p.ProcessId;ppid=[int]$p.ParentProcessId;name=[string]$p.Name;path=[string]$p.ExecutablePath}; if($p.ParentProcessId -eq $evolverPid){break}; $evolverPid=[int]$p.ParentProcessId }; ConvertTo-Json -InputObject @($evolverRows) -Compress`;
  try {
    const result = run(win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 2500, maxBuffer: 128 * 1024, windowsHide: true });
    if (result.error || result.status !== 0) return empty();
    const rows = JSON.parse(result.stdout);
    if (!Array.isArray(rows) || rows.length > 16 || rows.some(row => !Number.isSafeInteger(row.pid) || row.pid <= 0 || !Number.isSafeInteger(row.ppid) || row.ppid < 0 || typeof row.name !== 'string' || typeof row.path !== 'string')) return empty();
    return new Map(rows.map(({ pid: key, ...info }) => [key, info]));
  } catch { return empty(); }
}

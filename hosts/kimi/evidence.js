// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { isAbsolute, resolve } from 'node:path';

export function editedFilesOf(payload) {
  if (payload.hook_event_name !== 'PreToolUse' || !['Write', 'Edit'].includes(payload.tool_name)) return [];
  const file = payload.tool_input?.path;
  if (typeof file !== 'string' || !file || file.includes('\0')) return [];
  if (isAbsolute(file)) return [file];
  return typeof payload.cwd === 'string' && isAbsolute(payload.cwd) ? [resolve(payload.cwd, file)] : [];
}

export const kimiEvidence = Object.freeze({
  // Kimi truncates hook tool_output: a turn's evidence is read from its session log once the turn ended.
  toolNote: () => null,
  editedFiles: editedFilesOf,
});

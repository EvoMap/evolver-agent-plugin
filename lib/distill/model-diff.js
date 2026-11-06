// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { withoutSecrets } from '../redact.js';

// The model reads the range's diff, not replays it: a diff too long for a prompt becomes a file list with each file's
// added and removed line counts, then each file's first hunks while they fit. The whole diff still goes to the Proxy.

export const MODEL_DIFF_MAX_BYTES = 24 * 1024;
const LINE_MAX_CHARS = 400;
const HUNK_MAX_LINES = 40;

const bytesOf = (text) => new TextEncoder().encode(text).length;
const linesBytesOf = (lines) => lines.reduce((sum, line) => sum + bytesOf(line) + 1, 0);
const clippedLine = (line) => (line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS - 1)}…` : line);

function fileOf(chunk) {
  const lines = chunk.split('\n');
  const path = /^diff --git a\/(.+?) b\//.exec(lines[0])?.[1] ?? lines[0];
  const binary = lines.some((line) => line === 'GIT binary patch' || line.startsWith('Binary files '));
  const hunkAt = lines.findIndex((line) => line.startsWith('@@'));
  const body = hunkAt < 0 || binary ? [] : lines.slice(hunkAt);
  const counted = (sign) => body.filter((line) => line.startsWith(sign) && !line.startsWith(sign.repeat(3))).length;
  return { path, binary, header: lines.slice(0, hunkAt < 0 ? lines.length : hunkAt), body, added: counted('+'), removed: counted('-') };
}

const filesOf = (diff) => diff.split(/\n(?=diff --git )/).filter((chunk) => chunk.startsWith('diff --git ')).map(fileOf);

const shownLinesOf = (file) => (file.binary ? [file.header[0], `Binary file ${file.path} changed`] : [...file.header, ...file.body].filter((line) => line !== ''));

function firstHunkOf(file) {
  const next = file.body.findIndex((line, index) => index > 0 && line.startsWith('@@'));
  return file.body.slice(0, next < 0 ? HUNK_MAX_LINES : Math.min(next, HUNK_MAX_LINES));
}

function summaryLinesOf(files, maxBytes) {
  const totals = files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
  const lines = [`Diff too long to show whole: ${files.length} files, +${totals.added} -${totals.removed}.`];
  for (const [index, file] of files.entries()) {
    const line = clippedLine(`${file.path} ${file.binary ? '(binary)' : `+${file.added} -${file.removed}`}`);
    if (linesBytesOf(lines) + bytesOf(line) + 64 > maxBytes) return [...lines, `… and ${files.length - index} more files.`];
    lines.push(line);
  }
  for (const file of files.filter((candidate) => !candidate.binary)) {
    const hunk = [`First change in ${file.path}:`, ...firstHunkOf(file)].map(clippedLine);
    if (linesBytesOf(lines) + linesBytesOf(hunk) > maxBytes) break;
    lines.push(...hunk);
  }
  return lines;
}

/** The lines of `diff` a model is shown, redacted and within `maxBytes`. */
export function modelDiffLinesOf(diff, maxBytes = MODEL_DIFF_MAX_BYTES) {
  if (typeof diff !== 'string' || !diff.trim()) return [];
  const files = filesOf(diff);
  const whole = files.flatMap(shownLinesOf).map(clippedLine);
  const lines = linesBytesOf(whole) <= maxBytes ? whole : summaryLinesOf(files, maxBytes);
  return lines.map(withoutSecrets);
}

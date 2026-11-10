// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { closeSync, openSync, readSync, statSync } from 'node:fs';

const MAX_READ_BYTES = 4 * 1024 * 1024;

/** The Transcripts port: a host's transcript file, read from a byte offset an earlier event recorded. */
export const transcripts = Object.freeze({
  size(file) {
    try {
      return typeof file === 'string' && file ? statSync(file).size : 0;
    } catch {
      return 0;
    }
  },
  readSince(file, offset = 0) {
    if (typeof file !== 'string' || !file) return '';
    let fd;
    try {
      const size = statSync(file).size;
      const start = Number.isInteger(offset) && offset >= 0 && offset <= size ? offset : 0;
      const length = Math.min(size - start, MAX_READ_BYTES);
      if (length <= 0) return '';
      const buffer = Buffer.alloc(length);
      fd = openSync(file, 'r');
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } catch {
      return '';
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
});

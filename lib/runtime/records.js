// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { lstatSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Reads one declared metadata projection; the host supplies a fixed query, never SQL from a payload. */
export function recordReaderOf(declaration, env) {
  if (!declaration) return undefined;
  return (...keys) => {
    if (!keys.length || keys.length > 2 || keys.some(key => typeof key !== 'string' || !key || key.length > 256)) return null;
    let db;
    try {
      const file = declaration.file(env);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(file, { readOnly: true });
      db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 250');
      return db.prepare(declaration.query).get(...keys) ?? null;
    } catch { return null; }
    finally { try { db?.close(); } catch {} }
  };
}

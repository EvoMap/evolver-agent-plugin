// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { lstatSync, readFileSync } from 'node:fs';

import { withLock, writeState } from './store/file-lock.js';

const KEYS = ['recall', 'autoDistill'];
function checked(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.entries(value).some(([key, flag]) => !KEYS.includes(key) || typeof flag !== 'boolean')) throw new Error('Plugin settings must contain only boolean recall and autoDistill fields.');
  return value;
}

function readSaved(file) {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid settings file');
    return checked(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

const INVALID = 'Plugin settings are invalid or unreadable; recall and automatic distillation are paused. Repair the settings file before changing preferences.';

/** Persistent host preferences survive native hook environments which strip inherited variables. */
export function settingsOf(env, file) {
  const effective = saved => ({ recall: env.EVOLVER_RECALL === undefined ? saved.recall ?? true : env.EVOLVER_RECALL !== 'off', autoDistill: env.EVOLVER_AUTO_DISTILL === undefined ? saved.autoDistill ?? true : env.EVOLVER_AUTO_DISTILL !== 'off' });
  if (!file) return effective({});
  let saved = {}, error;
  try { saved = readSaved(file); } catch { error = INVALID; }
  const settings = { ...(error ? { recall: false, autoDistill: false } : effective(saved)), file, error };
  settings.configure = async patch => {
    if (error) throw new Error(error);
    checked(patch);
    const written = await withLock(`${file}.lock`, async () => {
      let current;
      try { current = readSaved(file); } catch { throw new Error(INVALID); }
      const next = { ...current, ...patch };
      writeState(file, next);
      Object.assign(settings, effective(next));
    });
    if (!written) throw new Error('Another preference update is running; retry the command.');
  };
  return settings;
}

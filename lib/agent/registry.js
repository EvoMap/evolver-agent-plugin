// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { existsSync } from 'node:fs';

const NAME = /^[a-z][a-z0-9-]*$/;

/** The profile of the agent `name`, loaded by convention from hosts/<name>/profile.js; null when there is none. */
export async function profileNamed(name) {
  if (!NAME.test(String(name ?? ''))) return null;
  const file = new URL(`../../hosts/${name}/profile.js`, import.meta.url);
  if (!existsSync(file)) return null;
  return (await import(file.href)).default;
}

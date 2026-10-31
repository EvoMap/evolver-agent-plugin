// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { join } from 'node:path';

import { dataDirOf } from './paths.js';

const ROUTE = /^[A-Za-z0-9_:.@-]+\/[A-Za-z0-9_:.@/-]+$/;
const VARIANT = /^[A-Za-z0-9_.-]+$/;

export const modelRecord = Object.freeze({
  file: env => join(dataDirOf(env), 'v2', 'sqlite', 'runtime-state.sqlite'),
  // shortcut: read the 0.7.4/v2 schema until native hooks expose a provider-qualified model route.
  query: `SELECT CASE WHEN d.session_id IS NOT NULL THEN json_extract(d.definition_json, '$.model.providerId') || '/' || json_extract(d.definition_json, '$.model.modelId') ELSE json_extract(s.extra_data_json, '$.effectiveModel') END AS route,
    CASE WHEN d.session_id IS NOT NULL THEN json_extract(d.definition_json, '$.model.variant') ELSE json_extract(s.extra_data_json, '$.effectiveModelVariant') END AS variant
    FROM local_runtime_sessions s LEFT JOIN local_runtime_session_agent_definitions d ON d.session_id = s.session_id WHERE s.session_id = ?`,
});

/** Capture the verified turn's route before a later session/default-model change can replace it. */
export function sessionModelOf(payload, context) {
  const row = context?.modelRecord?.(payload.session_id);
  if (!row || typeof row.route !== 'string' || !ROUTE.test(row.route) || row.route.length > 512 || (row.variant != null && (typeof row.variant !== 'string' || !VARIANT.test(row.variant)))) return { model: 'unresolved' };
  const bare = row.route.slice(row.route.indexOf('/') + 1);
  const reported = typeof payload.model === 'string' ? payload.model : '';
  if (reported && reported !== bare && reported !== row.route && reported !== `${row.route}#${row.variant}`) return { model: 'unresolved' };
  return { model: row.variant ? `${row.route}#${row.variant}` : row.route };
}

export function modelArguments(model) {
  if (model?.model === 'native-default') return []; // Older candidates predate route snapshots.
  const value = model?.model;
  const [route, variant, extra] = typeof value === 'string' ? value.split('#') : [];
  if (!ROUTE.test(route ?? '') || value.length > 600 || extra !== undefined || (variant !== undefined && !VARIANT.test(variant))) throw new Error('MiniMax session model route is unavailable or inconsistent; no completion was started.');
  return ['--model', value];
}

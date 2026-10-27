// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { containsSecret, withoutSecrets } from './redact.js';

export const DRAFTS_TTL_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_DRAFTS = 20;
const MAX_TRACE_ROWS = 8;
const MAX_ARTIFACTS = 12;
const COMMAND_MAX_CHARS = 180;
const TITLE_MAX_CHARS = 80;
const SUMMARY_MIN_CHARS = 40;
const SUMMARY_MAX_CHARS = 300;
const MIN_STRATEGY_STEPS = 3;
const MAX_STRATEGY_STEPS = 10;
const STEP_MAX_CHARS = 220;
const MAX_SIGNALS = 8;
const SCOPE_MAX_CHARS = 300;

// A turn is worth distilling only when it changed something and the last check
// it ran passed: that is the only evidence a hook observes for itself, and the
// Proxy's quality gate rejects learning without it anyway.
export function isDistillableTurn({ reason, agentId, isPersonTurn, changedLines, checks }) {
  if (reason !== 'answer' || agentId !== undefined || !isPersonTurn) return false;
  if (!(changedLines > 0) || !Array.isArray(checks) || checks.length === 0) return false;
  return checks.at(-1).failed === false;
}

export function distillPromptOf(scope = '') {
  const focus = typeof scope === 'string' && scope.trim()
    ? `\nFocus on: ${withoutSecrets(scope).trim().slice(0, SCOPE_MAX_CHARS)}`
    : '';
  return [
    'Evolver distillation step. Do not continue the task and do not address the user.',
    'Decide whether the most recent piece of verified work in this conversation contains a reusable approach that would help on a similar task in a different repository.',
    'Answer with one JSON object and nothing else:',
    '{"reusable": false}',
    'or',
    '{"reusable": true, "title": "<short capability name>", "summary": "<what was solved and under which conditions, 40-300 characters>", "strategy": ["<step>", "<step>", "<step>"], "signals": ["<error code or trigger keyword>"]}',
    'Rules: at least three concrete, reproducible steps; generalize repository-specific names; never include secrets, tokens, credentials, personal data or absolute paths; answer {"reusable": false} for routine, trivial or one-off edits.',
  ].join('\n') + focus;
}

function textList(value, max, maxChars) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim().slice(0, maxChars))
    .slice(0, max);
}

function firstJsonObject(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// The reply is the model's own reading of the transcript; anything short of a
// complete, secret-free lesson is dropped rather than repaired.
export function lessonOf(replyText) {
  const reply = firstJsonObject(replyText);
  if (!reply || reply.reusable !== true) return null;
  const title = typeof reply.title === 'string' ? reply.title.trim().slice(0, TITLE_MAX_CHARS) : '';
  const summary = typeof reply.summary === 'string' ? reply.summary.trim().slice(0, SUMMARY_MAX_CHARS) : '';
  const strategy = textList(reply.strategy, MAX_STRATEGY_STEPS, STEP_MAX_CHARS);
  const signals = textList(reply.signals, MAX_SIGNALS, 60);
  if (!title || summary.length < SUMMARY_MIN_CHARS || strategy.length < MIN_STRATEGY_STEPS) return null;
  if ([title, summary, ...strategy, ...signals].some(containsSecret)) return null;
  return { title, summary, strategy, signals };
}

// A command rerun after a fix counts once, as its last run: an earlier failure
// of the same command is the fix's history, not a failing validation.
function lastRunOfEachCheck(checks) {
  const byCommand = new Map();
  for (const check of checks) {
    const command = String(check.command ?? '').trim().slice(0, COMMAND_MAX_CHARS);
    if (!command) continue;
    byCommand.delete(command);
    byCommand.set(command, check.failed ? 1 : 0);
  }
  return [...byCommand].slice(-MAX_TRACE_ROWS).map(([command, exit]) => ({ command, exit }));
}

function relativeArtifacts(paths, projectDir) {
  const prefix = projectDir ? `${projectDir.replace(/\/+$/, '')}/` : null;
  const relative = paths
    .filter((path) => typeof path === 'string' && path)
    .map((path) => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path))
    .filter((path) => !path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path) && !containsSecret(path));
  return [...new Set(relative)].slice(0, MAX_ARTIFACTS);
}

export function distillRequestOf({ lesson, checks, paths, projectDir, sessionId, platform }) {
  const trace = lastRunOfEachCheck(checks);
  return {
    method: 'POST',
    path: '/conversation/distill',
    body: {
      platform,
      title: lesson.title,
      summary: lesson.summary,
      strategy: lesson.strategy,
      signals: lesson.signals,
      artifacts: relativeArtifacts(paths, projectDir),
      validation: trace.filter((row) => row.exit === 0).map((row) => row.command),
      execution: { trace },
      session_id: sessionId,
      persist: false,
      publish: false,
    },
  };
}

// Without a host verifier the Proxy answers a draft and stores nothing, so the
// draft's Gene and Capsule are what the person later publishes or discards.
export function draftOf(result, { title, sessionId }, now) {
  const gene = result?.gene;
  const capsule = result?.capsule;
  if (result?.ok !== true || result.quality?.ok !== true || !result.distill_id || !gene?.asset_id || !capsule?.asset_id) return null;
  return {
    id: String(result.distill_id),
    title,
    summary: String(capsule.summary ?? gene.summary ?? ''),
    signals: Array.isArray(result.signals) ? result.signals : [],
    score: result.quality?.score ?? null,
    assets: [gene, capsule],
    sessionId,
    createdAt: now,
  };
}

function prunedDrafts(drafts, now) {
  return (Array.isArray(drafts) ? drafts : []).filter((draft) => now - Number(draft?.createdAt) <= DRAFTS_TTL_MS);
}

export function skipReasonOf(result) {
  if (result?.ok !== true) return String(result?.reason ?? 'skipped');
  if (result.quality?.ok !== true) return String(result.quality?.reason ?? 'quality_gate');
  return 'incomplete_draft';
}

export function withDraft(drafts, draft, now) {
  const kept = prunedDrafts(drafts, now).filter((existing) => existing.id !== draft.id);
  return [...kept, draft].slice(-MAX_DRAFTS);
}

export function withoutDraft(drafts, id, now) {
  return prunedDrafts(drafts, now).filter((draft) => draft.id !== id);
}

// `1` names the first listed draft; anything else is matched as an id prefix
// so a copied id works too.
export function draftNamed(drafts, selector) {
  const wanted = String(selector ?? '').trim();
  if (!wanted) return null;
  const list = Array.isArray(drafts) ? drafts : [];
  if (/^\d+$/.test(wanted)) return list[Number(wanted) - 1] ?? null;
  const matches = list.filter((draft) => draft.id.startsWith(wanted));
  return matches.length === 1 ? matches[0] : null;
}

export function submitRequestOf(draft) {
  return {
    method: 'POST',
    path: '/asset/submit',
    body: { assets: draft.assets, request_id: `evolver-agent-plugin.draft.${draft.id}`.slice(0, 128) },
  };
}

export function draftsListText(drafts) {
  const list = Array.isArray(drafts) ? drafts : [];
  if (list.length === 0) return 'No distilled drafts are waiting.';
  const lines = list.map((draft, index) => `${index + 1}. ${draft.title} (${draft.id.slice(0, 12)}) — ${draft.summary}`);
  return [
    `${list.length} distilled draft${list.length === 1 ? '' : 's'} waiting for review:`,
    ...lines,
    'Publish one to the EvoMap Hub with `/evolver-drafts publish <number>`, or drop it with `/evolver-drafts discard <number>`.',
  ].join('\n');
}

export function draftNoticeText(draft, total) {
  const others = total > 1 ? ` (${total} waiting)` : '';
  return `Evolver distilled "${draft.title}" from this turn${others}. Review it with /evolver-drafts.`;
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { distillSession } from '../distill-session.js';
import { failure, success } from './result.js';

const reasonOf = ({ reason, terms, field }) => `${reason}${terms?.length ? `: ${terms.join(', ')}` : field ? `: ${field}` : ''}`;

function resultLineOf(result) {
  switch (result.status) {
    case 'drafted': return `Distilled "${result.title}" into a draft.`;
    case 'stored': return `Stored "${result.title}".`;
    case 'rejected': return `"${result.title}" was rejected by ${result.by === 'plugin' ? 'the plugin\'s shape check' : 'the Proxy'} (${reasonOf(result)}).`;
    case 'superseded': return `"${result.title}" was not kept: a draft with the same ID is already saved.`;
    case 'draft_missing': return `"${result.title}": the distilled draft is no longer available.`;
    case 'dropped': return `"${result.title}" was discarded: the session's work changed while it was distilled.`;
    case 'cleanup_failed': return `"${result.title}" was invalidated by a correction, and Evolver could not remove its draft. Check /evolver-drafts and discard it if it is still listed.`;
    default: return `"${result.title}" could not be sent (${result.error ?? result.reason}).`;
  }
}

function postedText(outcome) {
  const lines = outcome.results.map(resultLineOf);
  const drafted = outcome.results.some((result) => result.status === 'drafted');
  const text = [...lines, ...(drafted ? ['Publish a draft with /evolver-drafts publish <number>, or list drafts with /evolver-drafts.'] : [])].join('\n');
  return outcome.status === 'stored' || drafted ? success(text) : failure(text);
}

export function distillText(outcome) {
  if (outcome.results) return postedText(outcome);
  switch (outcome.status) {
    case 'nothing': return failure('Nothing to distill yet: no work turn of this session waits for it.');
    case 'busy': return failure('Another process is distilling this session right now.');
    case 'below_threshold': return failure(`Not distilled: ${outcome.detail}.`);
    case 'blocked': return failure(`Distillation is blocked (${outcome.reason}). Restore the selected model configuration and retry /evolver-distill.`);
    case 'route_not_captured': return failure('The session\'s work has no captured model route. Finish a new work turn so Evolver can capture its model route.');
    case 'declined': return success(`No Gene: the session holds no method worth reusing (${outcome.reason}).`);
    case 'unparsed': return failure('The answer must be JSON: an array of up to two session-gene-ir-v1 objects, or {"skip": "<why>"}.');
    case 'dropped': return failure('The session\'s work changed after this answer was asked for.');
    default: return failure(`Distillation ${outcome.status}${outcome.error ? `: ${outcome.error}` : ''}.`);
  }
}

export default {
  name: 'evolver-distill',
  description: "Distill this session's work since its last distillation into draft Genes now, instead of once the session goes quiet or ends.",
  hint: '[focus]',
  async run(ports, { sessionId, args, anySession }) {
    const outcome = await distillSession(ports, { sessionId, focus: args, anySession });
    const answer = distillText(outcome);
    return outcome.agentGene ? { ...answer, agentGene: outcome.agentGene } : answer;
  },
};

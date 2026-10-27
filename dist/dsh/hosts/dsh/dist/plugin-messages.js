// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { randomUUID } from 'node:crypto';

const SOURCE_KIND = 'plugin:evolver';
const SUMMARY_MAX_CHARS = 120;

const summaryOf = (text) => (text.length <= SUMMARY_MAX_CHARS ? text : `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…`);

// The packed plugin ships no dsh package, so this builds what `createUserMessage` of @deepseek-ai/dsh-llm does: an
// identified, frozen user message naming its producer.
function pluginMessage(text, formed) {
  const block = Object.freeze({ type: 'text', text });
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([block]),
    source: Object.freeze({ kind: SOURCE_KIND, ...formed }),
  });
}

export const strategyMessage = (text) => pluginMessage(text, { form: 'recall' });

export const noticeMessage = (text) => pluginMessage(text, { form: 'notice', summary: summaryOf(text.split('\n')[0]) });

export const instructionsMessage = (text) => pluginMessage(text, { form: 'instructions' });

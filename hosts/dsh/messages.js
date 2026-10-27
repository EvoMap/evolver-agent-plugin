// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

const PERSON = 'user';

const text = (value) => (typeof value === 'string' ? value : '');

const textsOf = (message) => (message?.content ?? [])
  .filter((block) => block?.type === 'text')
  .map((block) => text(block.text).trim())
  .filter(Boolean);

export const personTextOf = (messages) => (messages ?? []).filter((message) => message?.source?.kind === PERSON).flatMap(textsOf).join('\n');

export const answerTextOf = (message) => textsOf(message).join('\n');

export function modelOf(message) {
  const source = message?.source;
  return text(source?.provider) && text(source?.model) ? { provider: source.provider, model: source.model } : null;
}

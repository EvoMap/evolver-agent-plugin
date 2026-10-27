// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { setTimeout as sleep } from 'node:timers/promises';

import { instructionsMessage } from './plugin-messages.js';

const FAILED_FINISHES = new Set(['error', 'aborted']);
const ROUTE_WAIT_MS = 10_000;
const ROUTE_POLL_MS = 100;

const hasRoute = (llm, provider) => llm.listProviders?.().some((info) => info.id === provider) ?? true;

// dsh withdraws its provider adapters as it shuts down, before its plugins unload, and a headless run shuts down as
// soon as it answers. A distillation that finds its route gone waits on a timer that holds no process open: when
// the process ends meanwhile, the candidate is claimed again by the next session start rather than counted failed.
async function routeRegistered(llm, provider, signal) {
  const deadline = Date.now() + ROUTE_WAIT_MS;
  while (!hasRoute(llm, provider)) {
    if (Date.now() >= deadline || signal?.aborted) return false;
    await sleep(ROUTE_POLL_MS, undefined, { ref: false });
  }
  return true;
}

async function streamedAnswer(llm, { provider, model }, prompt, signal) {
  let answer = '';
  let usage = null;
  for await (const chunk of llm.stream({ provider, model, messages: [instructionsMessage(prompt)], signal })) {
    if (chunk.type === 'text-delta') answer += chunk.text;
    else if (chunk.type === 'usage') usage = chunk.usage;
    else if (chunk.type === 'finish' && FAILED_FINISHES.has(chunk.reason?.kind)) throw new Error(chunk.reason.failure?.message ?? `the model call ended ${chunk.reason.kind}`);
  }
  return { answer, usage };
}

export function dshModel(llmOf) {
  return {
    async complete(model, prompt, signal) {
      const llm = llmOf();
      if (!llm) throw new Error('this DeepSeek Harness profile has no model service');
      if (!(await routeRegistered(llm, model.provider, signal))) throw new Error(`DeepSeek Harness has no provider route "${model.provider}"`);
      return streamedAnswer(llm, model, prompt, signal);
    },
  };
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { createHash } from 'node:crypto';

const variants = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const reasons = new Set(['route_unresolved', 'route_changed', 'credential_missing', 'auth_unsupported', 'unsafe_runtime']);
const id = (value) => typeof value === 'string' && /^[\w.@:/+-]{1,256}$/.test(value);
const unavailable = (reason) => Object.assign(new Error('The captured Step Code model is unavailable'), { code: 'MODEL_UNAVAILABLE', reason });
const safeUnavailable = (error) => unavailable(error?.code === 'MODEL_UNAVAILABLE' && reasons.has(error.reason) ? error.reason : 'credential_missing');
const ordered = (value) => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
const digestOf = (value) => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
const stopped = (signal) => new DOMException('Step Code completion stopped', signal.reason?.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError');

async function withSignal(work, signal) {
  if (signal.aborted) throw stopped(signal);
  let abort;
  try {
    return await Promise.race([work(), new Promise((_resolve, reject) => {
      abort = () => reject(stopped(signal));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

async function snapshotOf(ctx) {
  const model = structuredClone(ctx?.model);
  const original = digestOf(model);
  const variant = ctx?.thinkingLevel ?? 'off';
  const registry = ctx?.modelRegistry;
  if (!id(model?.provider) || !id(model?.id) || !variants.has(variant)
    || typeof registry?.getProvider !== 'function' || typeof registry?.getApiKeyAndHeaders !== 'function') {
    throw unavailable('route_unresolved');
  }
  const provider = registry.getProvider(model.provider);
  if (provider?.id !== model.provider || typeof provider.streamSimple !== 'function') throw unavailable('unsafe_runtime');
  const stream = provider.streamSimple;
  const resolved = await registry.getApiKeyAndHeaders(model);
  if (resolved?.ok !== true || typeof resolved.apiKey !== 'string' || !resolved.apiKey.trim()) throw unavailable('credential_missing');
  const auth = structuredClone({ apiKey: resolved.apiKey, headers: resolved.headers, env: resolved.env });
  if (digestOf(ctx.model) !== original || (ctx.thinkingLevel ?? 'off') !== variant
    || registry.getProvider(model.provider) !== provider || provider.streamSimple !== stream) throw unavailable('route_changed');
  if (resolved.baseUrl) model.baseUrl = resolved.baseUrl;
  return {
    ctx, provider, stream, model, auth,
    descriptor: { configDigest: digestOf({ model, variant, auth, defaults: { baseUrl: provider.baseUrl, headers: provider.headers } }),
      selection: { providerId: model.provider, modelId: model.id, variant } },
  };
}

/** Credentials stay in the active native process; only an opaque route digest enters session state. */
export function stepModel() {
  let captured;
  let generation = 0;
  const requests = new Set();
  const invalidate = () => {
    captured = undefined;
    for (const request of requests) request.abort();
  };
  return {
    capture: true,
    async captureContext(ctx) {
      const attempt = ++generation;
      try {
        const next = await snapshotOf(ctx);
        if (attempt !== generation) throw unavailable('route_changed');
        if (next.descriptor.configDigest === captured?.descriptor.configDigest && next.provider === captured.provider && next.stream === captured.stream) {
          captured.ctx = ctx;
        } else { invalidate(); captured = next; }
        return structuredClone(captured.descriptor);
      } catch (error) {
        if (attempt === generation) invalidate();
        throw safeUnavailable(error);
      }
    },
    configStamp: () => captured?.descriptor.configDigest ?? null,
    async complete(descriptor, prompt, stopping) {
      const binding = captured;
      if (!binding || digestOf(descriptor) !== digestOf(binding.descriptor)) throw unavailable('route_unresolved');
      const request = new AbortController();
      const timer = setTimeout(() => request.abort(new DOMException('Deadline', 'TimeoutError')), 90_000);
      timer.unref();
      requests.add(request);
      const signal = stopping ? AbortSignal.any([stopping, request.signal]) : request.signal;
      const check = async () => {
        const current = await withSignal(() => snapshotOf(binding.ctx).catch((error) => { throw safeUnavailable(error); }), signal);
        if (signal.aborted) throw stopped(signal);
        if (captured !== binding || current.descriptor.configDigest !== binding.descriptor.configDigest
          || current.provider !== binding.provider || current.stream !== binding.stream) throw unavailable('route_changed');
      };
      try {
        await check();
        const result = await withSignal(() => binding.stream.call(binding.provider, structuredClone(binding.model), {
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }], tools: [],
        }, {
          ...structuredClone(binding.auth), maxTokens: 1_024, reasoning: binding.descriptor.selection.variant === 'off' ? undefined : binding.descriptor.selection.variant,
          toolChoice: 'none', cacheRetention: 'none', signal, timeoutMs: 90_000, maxRetries: 0,
        }).result(), signal).catch(() => {
          if (signal.aborted) throw stopped(signal);
          throw new Error('Step Code completion failed');
        });
        await check();
        if (result?.role !== 'assistant' || result.provider !== binding.model.provider || result.model !== binding.model.id
          || result.api !== binding.model.api || result.stopReason !== 'stop' || !Array.isArray(result.content)
          || result.content.some((part) => !part || (part.type !== 'thinking' && (part.type !== 'text' || typeof part.text !== 'string')))) {
          throw new Error('Step Code returned no complete answer');
        }
        const answer = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        if (!answer.trim() || answer.length > 1_048_576) throw new Error('Step Code returned no complete answer');
        const { input, output } = result.usage ?? {};
        return { answer, ...(Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0
          && { usage: { inputTokens: input, outputTokens: output } }) };
      } finally { clearTimeout(timer); requests.delete(request); }
    },
    clear() { generation++; invalidate(); },
  };
}

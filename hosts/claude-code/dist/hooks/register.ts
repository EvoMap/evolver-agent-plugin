// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import type { EngineInterface, PluginOptions, Register } from 'claude-code'

// A hooks module has no Node, and `$` may only reach functions declared in this file. So the module only relays:
// it starts `bin/relay.mjs claude-code` for the session, sends it each event over loopback HTTP, applies the answers,
// and runs the model completions the relay asks for, since only the module holds the session's model.

type Relay = { url: string; token: string }
type Answer = { append?: string; toast?: string; submit?: string; text?: string; context?: string[]; exitCode?: number; late?: string }
type CatalogCommand = { name: string; description: string; hint?: string }
type ModelRequest = { id: string; model: string; prompt: string }

const AGENT = 'claude-code'
const RELAY_START_MS = 15_000
const MODEL_POLL_MS = 20_000
const MODEL_MAX_TOKENS = 4_096
const MODEL_TIMEOUT_MS = 120_000
const MAX_PENDING_PROMPTS = 32

let relay: Promise<Relay> | null = null
const promptOrigins = new Map<string, unknown>()
const commandNames = new Set<string>()

function quietly<T>(work: Promise<T>): Promise<T | null> {
  return work.catch(() => null)
}

function relayArgv($: EngineInterface, options: PluginOptions): string[] {
  const noModel = options.auto_distill === false ? ['--no-model'] : []
  return [String(options.node_path || 'node'), `${$.plugin.root}/bin/relay.mjs`, AGENT, ...noModel]
}

function relayEnv(options: PluginOptions): Record<string, string> {
  return {
    ...(options.proxy_port ? { EVOMAP_PROXY_PORT: String(options.proxy_port) } : {}),
    ...(options.recall_enabled === false ? { EVOLVER_RECALL: 'off' } : {}),
  }
}

// The relay prints `{ port, token }` once it listens. The loop below is the child's life: it runs on after the
// hook that started it, and the relay is started again by the next event once it has ended.
async function startRelay($: EngineInterface, options: PluginOptions): Promise<Relay> {
  const started = new Promise<Relay>((resolve, reject) => {
    void (async () => {
      let pending = ''
      let isUp = false
      try {
        for await (const piece of $.process.spawn({ argv: relayArgv($, options), env: relayEnv(options) })) {
          if (isUp || piece.stream !== 'stdout') continue
          pending += piece.text
          const newline = pending.indexOf('\n')
          if (newline < 0) continue
          const { port, token } = JSON.parse(pending.slice(0, newline))
          isUp = true
          resolve({ url: `http://127.0.0.1:${port}`, token })
          void serveModel($, { url: `http://127.0.0.1:${port}`, token })
        }
      } catch (error) {
        if (!isUp) reject(error)
      }
      relay = null
      if (!isUp) reject(new Error('the Evolver relay exited before it listened'))
    })()
  })
  started.catch(() => undefined)
  const waiting = new AbortController()
  const timedOut = $.clock.sleep(RELAY_START_MS, { signal: waiting.signal }).then(() => null, () => null)
  const relayed = await Promise.race([started, timedOut]).finally(() => waiting.abort())
  if (!relayed) throw new Error('the Evolver relay did not start in time')
  return relayed
}

function relayOf($: EngineInterface, options: PluginOptions): Promise<Relay> {
  relay ??= startRelay($, options).catch((error) => {
    relay = null
    throw error
  })
  return relay
}

async function postTo($: EngineInterface, { url, token }: Relay, path: string, body: unknown): Promise<any> {
  const response = await $.http.fetch(url + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`the Evolver relay answered ${path} with ${response.status}`)
  return JSON.parse(response.text || 'null')
}

async function post($: EngineInterface, options: PluginOptions, path: string, body: unknown): Promise<any> {
  return postTo($, await relayOf($, options), path, body)
}

async function sessionFields($: EngineInterface): Promise<{ session_id: string; cwd: string }> {
  const cwd = await $.session.cwd()
  const stat = await $.fs.stat(cwd, { resolve: true }).catch(() => undefined)
  return { session_id: await $.session.id(), cwd: stat?.realPath ?? cwd }
}

async function raise($: EngineInterface, options: PluginOptions, hostEvent: string, fields: Record<string, unknown> = {}): Promise<Answer> {
  return post($, options, '/event', { hostEvent, payload: { ...(await sessionFields($)), ...fields } })
}

async function appendHidden($: EngineInterface, text: string): Promise<void> {
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
}

// The relay's model requests are its distillations: each runs as one completion on the session's own client,
// outside the conversation, and its answer goes back by id.
async function serveModel($: EngineInterface, connection: Relay): Promise<void> {
  for (;;) {
    const request: ModelRequest | null = await postTo($, connection, '/model/next', { waitMs: MODEL_POLL_MS }).catch(() => undefined)
    if (request === undefined) return
    if (!request) continue
    const reply = await $.model.complete({ model: request.model, prompt: request.prompt, maxTokens: MODEL_MAX_TOKENS, timeoutMs: MODEL_TIMEOUT_MS })
      .catch((error: Error) => ({ isAnswered: false as const, reason: String(error?.message ?? error) }))
    const outcome = reply.isAnswered ? { id: request.id, text: reply.text, usage: reply.usage } : { id: request.id, error: String(reply.reason) }
    if ((await postTo($, connection, '/model/answer', outcome).catch(() => undefined)) === undefined) return
  }
}

async function registerCommands($: EngineInterface, options: PluginOptions): Promise<void> {
  const catalog: CatalogCommand[] = await post($, options, '/commands', {})
  for (const command of catalog) {
    await $.command.register({ name: command.name, description: command.description, ...(command.hint ? { argumentHint: command.hint } : {}) })
    commandNames.add(command.name)
  }
}

async function startSession($: EngineInterface, options: PluginOptions): Promise<void> {
  await registerCommands($, options)
  const answer = await raise($, options, 'session.start')
  if (answer.toast) $.ui.toast(answer.toast)
}

// A recall slower than the turn's wait goes on: once it lands, the relay books it only while the turn is still open,
// and it is added then, reaching the model from the turn's next step.
async function joinLate($: EngineInterface, options: PluginOptions, id: string): Promise<void> {
  const landed = await post($, options, '/late', { id })
  if (!landed) return
  const { joined } = await post($, options, '/late/join', { id: landed.id })
  if (joined) await appendHidden($, landed.text)
}

async function startTurn($: EngineInterface, options: PluginOptions, e: { text: string; turnId: string }, origin: unknown): Promise<void> {
  const answer = await raise($, options, 'turn.start', { turn_id: e.turnId, text: e.text, origin })
  if (answer.append) await appendHidden($, answer.append)
  if (answer.late) void quietly(joinLate($, options, answer.late))
}

function rememberOrigin(text: string, origin: unknown): void {
  promptOrigins.set(text, origin)
  if (promptOrigins.size > MAX_PENDING_PROMPTS) promptOrigins.delete(promptOrigins.keys().next().value!)
}

function isRelayRunning(): boolean {
  return relay !== null
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await quietly(startSession($, options))
    return next(e)
  })

  // `prompt.submit` names who sent the prompt but resolves only after its turn started, so its origin is kept
  // before `next`; `turn.start` then hands the turn to the relay, which decides whose prompt opens a turn.
  on('prompt.submit', async ($, e, next) => {
    rememberOrigin(e.text, e.origin)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (promptOrigins.has(e.text)) {
      const origin = promptOrigins.get(e.text)
      promptOrigins.delete(e.text)
      await quietly(startTurn($, options, e, origin))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await quietly(raise($, options, 'tool.call.before', { call: e }))
    const ran = await next(e)
    const result = { text: typeof ran.text === 'string' ? ran.text : '', isError: ran.isError === true, denied: ran.deny !== undefined }
    await quietly(raise($, options, 'tool.call', { call: e, result }))
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const answer = await quietly(raise($, options, 'turn.complete', {
      turn_id: e.turnId, reason: e.reason, answer: e.answer, usage: e.usage, agent_id: e.agentId, model: await $.session.model(),
    }))
    const answered = await next(e)
    return answer?.text ? { ...answered, text: answer.text } : answered
  })

  on('command.run', async ($, e, next) => {
    if (!commandNames.has(e.command)) return next(e)
    const answer = await raise($, options, 'command.run', { command: e.command, args: e.args })
    if (answer.submit) {
      void quietly($.prompt.submit({ text: answer.submit }))
      return {}
    }
    return { text: answer.text ?? '', ...(answer.context ? { context: answer.context } : {}), ...(answer.exitCode ? { exitCode: answer.exitCode } : {}) }
  }).catch(($, e, next) => next(e))

  // Every plugin's `session.end` shares one short bound, so the relay only writes; one that is not running is not
  // started for it, and the next session start settles what this one left.
  on('session.end', async ($, e, next) => {
    if (isRelayRunning()) await quietly(raise($, options, 'session.end', { session_id: e.sessionId }))
    promptOrigins.clear()
    return next(e)
  })
}

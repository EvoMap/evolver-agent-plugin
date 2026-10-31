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
type Landed = { id: string; text: string }

const AGENT = 'claude-code'
const RELAY_START_MS = 15_000
const RELAY_RETRY_MS = 30_000
const RELAY_RETRY_MAX_MS = 10 * 60_000
const MODEL_POLL_MS = 20_000
const MODEL_RETRY_MAX_MS = 30_000
const MODEL_MAX_TOKENS = 4_096
const MODEL_TIMEOUT_MS = 120_000
const MAX_PENDING_PROMPTS = 32
const UNKNOWN_ORIGIN = { kind: 'unknown' }

let relay: Promise<Relay> | null = null
let current: Relay | null = null
let failedStarts = 0
let retryAt = 0
let catalog: Promise<CatalogCommand[]> | null = null
const promptOrigins = new Map<string, unknown>()
const carried = new Map<string, Landed>()

function quietly<T>(work: Promise<T>): Promise<T | null> {
  return work.catch(() => null)
}

function relayArgv($: EngineInterface, options: PluginOptions): string[] {
  return [String(options.node_path || 'node'), `${$.plugin.root}/bin/relay.mjs`, AGENT]
}

function relayEnv(options: PluginOptions): Record<string, string> {
  return {
    ...(options.proxy_port ? { EVOMAP_PROXY_PORT: String(options.proxy_port) } : {}),
    ...(options.recall_enabled === false ? { EVOLVER_RECALL: 'off' } : {}),
    ...(options.auto_distill === false ? { EVOLVER_AUTO_DISTILL: 'off' } : {}),
  }
}

// The relay prints `{ port, token }` once it listens. The spawn's loop is the child's life: it runs on after the hook
// that started it, and leaving it (a start that timed out) kills the child. Only the relay still current clears itself
// when it ends; the next event then starts another.
async function startRelay($: EngineInterface, options: PluginOptions): Promise<Relay> {
  const pieces = $.process.spawn({ argv: relayArgv($, options), env: relayEnv(options) })
  let connection: Relay | null = null
  const started = new Promise<Relay>((resolve, reject) => {
    void (async () => {
      let pending = ''
      try {
        for await (const piece of pieces) {
          if (connection || piece.stream !== 'stdout') continue
          pending += piece.text
          const newline = pending.indexOf('\n')
          if (newline < 0) continue
          const { port, token } = JSON.parse(pending.slice(0, newline))
          connection = { url: `http://127.0.0.1:${port}`, token }
          current = connection
          resolve(connection)
          void serveModel($, connection)
        }
      } catch (error) {
        reject(error)
      }
      if (connection && current === connection) {
        current = null
        relay = null
      }
      reject(new Error('the Evolver relay exited before it listened'))
    })()
  })
  started.catch(() => undefined)
  const waiting = new AbortController()
  const timedOut = $.clock.sleep(RELAY_START_MS, { signal: waiting.signal }).then(() => null, () => null)
  const relayed = await Promise.race([started, timedOut]).finally(() => waiting.abort())
  if (relayed) return relayed
  await quietly(pieces.return({ code: null, signal: null }))
  throw new Error('the Evolver relay did not start in time')
}

// A relay that cannot start (no Node, a broken install) is not started again on every event: each failure waits
// longer before the next try, so a turn never pays for it more than once in a while.
function relayOf($: EngineInterface, options: PluginOptions, now: number): Promise<Relay> {
  if (!relay && now < retryAt) return Promise.reject(new Error('the Evolver relay is waiting to start again'))
  relay ??= startRelay($, options).then((started) => {
    failedStarts = 0
    return started
  }, (error) => {
    failedStarts += 1
    retryAt = now + Math.min(RELAY_RETRY_MS * 2 ** (failedStarts - 1), RELAY_RETRY_MAX_MS)
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
  return postTo($, await relayOf($, options, await $.clock.now()), path, body)
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
// outside the conversation, and its answer goes back by id. A failed poll is tried again for as long as this relay
// is the current one.
async function serveModel($: EngineInterface, connection: Relay): Promise<void> {
  let failures = 0
  while (current === connection) {
    const request: ModelRequest | null | undefined = await postTo($, connection, '/model/next', { waitMs: MODEL_POLL_MS }).catch(() => undefined)
    if (request === undefined) {
      failures += 1
      await quietly($.clock.sleep(Math.min(1_000 * 2 ** (failures - 1), MODEL_RETRY_MAX_MS)))
      continue
    }
    failures = 0
    if (!request) continue
    const reply = await $.model.complete({ model: request.model, prompt: request.prompt, maxTokens: MODEL_MAX_TOKENS, timeoutMs: MODEL_TIMEOUT_MS })
      .catch((error: Error) => ({ isAnswered: false as const, reason: String(error?.message ?? error) }))
    const outcome = reply.isAnswered ? { id: request.id, text: reply.text, usage: reply.usage } : { id: request.id, error: String(reply.reason) }
    await quietly(postTo($, connection, '/model/answer', outcome))
  }
}

// The commands ship beside this module, so they register at session start even before the relay is up, and are
// known after a hot reload.
function catalogOf($: EngineInterface): Promise<CatalogCommand[]> {
  catalog ??= $.fs.read(`${$.plugin.root}/hooks/commands.json`).then((text) => JSON.parse(String(text)), (error) => {
    catalog = null
    throw error
  })
  return catalog
}

async function registerCommands($: EngineInterface): Promise<void> {
  for (const command of await catalogOf($)) {
    await $.command.register({ name: command.name, description: command.description, ...(command.hint ? { argumentHint: command.hint } : {}) })
  }
}

async function isOurCommand($: EngineInterface, name: string): Promise<boolean> {
  const commands = await catalogOf($).catch(() => [])
  return commands.some((command) => command.name === name)
}

async function startSession($: EngineInterface, options: PluginOptions): Promise<void> {
  await quietly(registerCommands($))
  const answer = await raise($, options, 'session.start')
  if (answer.toast) $.ui.toast(answer.toast)
}

// A recall lands after `turn.start`, whose text never reaches the turn's first request: the strategy is added to the
// conversation when it lands, while its turn is open, and booked by the relay at the turn's next main-loop step after
// the first, the first that can carry it. A turn that ends first books nothing.
async function addWhenLanded($: EngineInterface, options: PluginOptions, turnId: string, id: string): Promise<void> {
  const landed: Landed | null = await post($, options, '/late', { id })
  if (!landed) return
  await appendHidden($, landed.text)
  carried.set(turnId, landed)
}

async function bookCarried($: EngineInterface, options: PluginOptions, turnId: string): Promise<void> {
  const landed = carried.get(turnId)
  if (!landed) return
  carried.delete(turnId)
  await post($, options, '/late/join', { id: landed.id })
}

async function startTurn($: EngineInterface, options: PluginOptions, e: { text: string; turnId: string }, origin: unknown): Promise<void> {
  const answer = await raise($, options, 'turn.start', { turn_id: e.turnId, text: e.text, origin })
  if (answer.append) await appendHidden($, answer.append)
  if (answer.late) void quietly(addWhenLanded($, options, e.turnId, answer.late))
}

function rememberOrigin(text: string, origin: unknown): void {
  promptOrigins.set(text, origin)
  if (promptOrigins.size > MAX_PENDING_PROMPTS) promptOrigins.delete(promptOrigins.keys().next().value!)
}

function originOf(text: string): unknown {
  const origin = promptOrigins.get(text) ?? UNKNOWN_ORIGIN
  promptOrigins.delete(text)
  return origin
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await quietly(startSession($, options))
    return next(e)
  })

  // `prompt.submit` names who sent the prompt but resolves only after its turn started, so its origin is kept
  // before `next`; `turn.start` hands the turn to the relay with it.
  on('prompt.submit', async ($, e, next) => {
    rememberOrigin(e.text, e.origin)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await quietly(startTurn($, options, e, originOf(e.text)))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && e.index > 0) await quietly(bookCarried($, options, e.turnId))
    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    await quietly(raise($, options, 'tool.call.before', { call: e }))
    const ran = await next(e)
    const result = { text: typeof ran.text === 'string' ? ran.text : '', isError: ran.isError === true, denied: ran.deny !== undefined }
    const answer = await quietly(raise($, options, 'tool.call', { call: e, result }))
    return answer?.append && ran.deny === undefined ? { ...ran, context: [...(ran.context ?? []), answer.append] } : ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    carried.delete(e.turnId)
    const answer = await quietly(raise($, options, 'turn.complete', {
      turn_id: e.turnId, reason: e.reason, answer: e.answer, usage: e.usage, agent_id: e.agentId, model: await $.session.model(),
    }))
    const answered = await next(e)
    return answer?.text ? { ...answered, text: answer.text } : answered
  })

  on('command.run', async ($, e, next) => {
    if (!(await isOurCommand($, e.command))) return next(e)
    const answer = await raise($, options, 'command.run', { command: e.command, args: e.args })
    if (answer.submit) {
      void quietly($.prompt.submit({ text: answer.submit }))
      return {}
    }
    return { text: answer.text ?? '', ...(answer.context ? { context: answer.context } : {}), ...(answer.exitCode ? { exitCode: answer.exitCode } : {}) }
  }).catch(($, e, next) => next(e))

  // Every plugin's `session.end` shares one short bound, so the relay only writes; one that is not listening is neither
  // started nor waited for, and the next session start settles what this one left.
  on('session.end', async ($, e, next) => {
    if (current) await quietly(raise($, options, 'session.end', { session_id: e.sessionId }))
    promptOrigins.clear()
    carried.clear()
    return next(e)
  })
}

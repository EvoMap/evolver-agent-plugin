// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

// The ports the use cases depend on: the one place their contract is written down. lib/runtime implements them,
// once per execution environment; a use case takes `(ports, input)` and reads only the ports it names. Every
// method may return a Promise, so a store backed by an asynchronous host API fits as well as a file.
//
// `update(…, mutate)` applies `mutate(current) → next | undefined` atomically and resolves to what it returned;
// undefined leaves the state as it was.

/**
 * @typedef {object} Identity          Which agent this is: names task ids, the distill platform and notices.
 * @property {string} agent
 * @property {string} label
 *
 * @typedef {object} SessionStore
 * @property {(sessionId: string) => Promise<object>} read
 * @property {(sessionId: string, mutate: Function) => Promise<object|undefined>} update
 * @property {(mutate: (session: object, sessionId: string) => object|undefined) => Promise<void>} updateEach
 *
 * @typedef {object} TurnNotes          What the turn's tool calls did, as they finished.
 * @property {(sessionId: string, note: object) => Promise<void>} append
 * @property {(sessionId: string) => Promise<{ notes: object[], commit: () => Promise<void> }>} take
 * @property {(sessionId: string) => Promise<void>} clear
 *
 * @typedef {object} EditBaseline       Each file's content hash before the turn first edited it.
 * @property {(sessionId: string, file: string, turnId?: string|null) => Promise<void>} remember
 * @property {(sessionId: string, turnId?: string|null) => Promise<{ before: Map<string, string>, commit: () => Promise<void> }>} take
 *
 * @typedef {object} TableStore         One table keyed by session id (distill candidates) or a list (drafts).
 * @property {() => Promise<object>} read
 * @property {(mutate: Function) => Promise<object|undefined>} update
 *
 * @typedef {object} ReportQueue
 * @property {(entries: { report: object, sessionId: string }[]) => Promise<void>} enqueue
 *
 * @typedef {object} Outbox             Held by one process at a time while it delivers.
 * @property {(deliver: (outbox: object, afterAttempt: Function) => Promise<object>) => Promise<boolean>} drain
 *
 * @typedef {object} RetentionStore
 * @property {(entry: { sessionId, projectDir, reuses, editedBefore: Map }) => Promise<void>} remember
 * @property {(due: { sessionId, projectDir }) => Promise<{ due: object[], commit: () => Promise<void> }>} takeDue
 *
 * @typedef {object} Proxy
 * @property {(method: string, path: string, body?: object, options?: { timeoutMs?: number, signal?: AbortSignal }) =>
 *   Promise<{ ok: true, data: any } | { ok: false, error: string }>} request
 *
 * @typedef {object} ModelRunner        The agent's model, run outside the conversation; absent when it has none.
 * @property {(model: any, prompt: string, signal: AbortSignal) => Promise<{ answer: string, usage?: object }>} complete
 *
 * @typedef {object} OwnerProbe         The process a session belongs to, this process, and whether a recorded one has exited.
 * @property {() => number|null} current
 * @property {() => number} self
 * @property {(pid: number|null) => boolean} isGone
 *
 * @typedef {object} Scheduler          Slow work the caller must not wait for.
 * @property {(tasks: ('engine'|'drain'|'distill')[]) => void} schedule
 * @property {() => Promise<void>} [idle]  Resolves once scheduled work is done, where it runs in this process.
 *
 * @typedef {object} Clock
 * @property {() => number} now
 * @property {(ms: number) => Promise<void>} sleep
 *
 * @typedef {object} Engine             Evolver itself: whether it needs setting up, setting it up, and its outcome.
 * @property {() => Promise<boolean>} needsSetup
 * @property {() => Promise<void>} setUp
 * @property {() => Promise<object|null>} outcome
 * @property {() => Promise<object|null>} takeUnannounced  The latest outcome once, then null until it changes.
 *
 * @typedef {object} LocalLedger
 * @property {(entry: { assetId, outcome, sessionId }) => Promise<boolean>} record
 *
 * @typedef {object} EvolverCli
 * @property {(args: string[], options?: { cwd?: string|null, signal?: AbortSignal }) => Promise<{ ok: boolean, text: string }>} run
 *
 * @typedef {object} Settings           What the person chose: EVOLVER_RECALL=off turns recall off,
 *                                      EVOLVER_AUTO_DISTILL=off distillation after a session (it still runs on demand).
 * @property {boolean} recall
 * @property {boolean} autoDistill
 *
 * @typedef {object} Ports
 * @property {Identity} identity
 * @property {SessionStore} sessions
 * @property {TurnNotes} notes
 * @property {EditBaseline} baseline
 * @property {TableStore} candidates
 * @property {TableStore} drafts
 * @property {ReportQueue} reports
 * @property {Outbox} outbox
 * @property {RetentionStore} retention
 * @property {Proxy} proxy
 * @property {ModelRunner|null} model
 * @property {OwnerProbe} owner
 * @property {Scheduler} scheduler
 * @property {Clock} clock
 * @property {Engine} engine
 * @property {LocalLedger} ledger
 * @property {EvolverCli} cli
 * @property {Settings} settings
 */

export const TASKS = Object.freeze({ ENGINE: 'engine', DRAIN: 'drain', DISTILL: 'distill' });

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
 * @property {(sessionId: string) => Promise<object[]>} read
 * @property {(sessionId: string) => Promise<{ notes: object[], commit: () => Promise<void> }>} take
 * @property {(sessionId: string) => Promise<void>} clear
 *
 * @typedef {object} EditBaseline       Each file's content hash before the turn first edited it.
 * @property {(sessionId: string, file: string, turnId?: string|null) => Promise<void>} remember
 * @property {(sessionId: string, turnId?: string|null) => Promise<{ before: Map<string, string>, commit: () => Promise<void> }>} take
 *
 * @typedef {object} TableStore         One table keyed by session id (each session's range of work turns to distill)
 *                                      or a list (drafts, the last distillation outcomes, the calibration corpus).
 * @property {() => Promise<object>} read
 * @property {(mutate: Function) => Promise<object|undefined>} update
 *
 * @typedef {object} DraftCorrections
 * @property {<T>(sessionId: string, work: () => T|Promise<T>, signal?: AbortSignal) => Promise<T>} withSession
 * @property {(sessionId: string, turn: number, sessionEpoch?: number) => Promise<void>} mark
 * @property {(sessionId: string, turn: number, sessionEpoch?: number) => Promise<boolean>} has
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
 * @typedef {object} Proxy              request initiates the transport before returning its promise.
 * @property {(method: string, path: string, body?: object, options?: { timeoutMs?: number, signal?: AbortSignal }) =>
 *   Promise<{ ok: true, data: any } | { ok: false, error: string, status?: number, data?: any }>} request
 *
 * @typedef {object} ModelRunner        The agent's model, run outside the conversation; absent when it has none.
 * @property {(model: any, prompt: string, signal: AbortSignal) => Promise<{ answer: string, usage?: object }>} complete
 *
 * @typedef {object} OwnerProbe         The process a session belongs to, this process, and whether a recorded one has exited.
 * @property {() => number|null} current
 * @property {() => number} self
 * @property {(pid: number|null) => boolean} isGone
 *
 * @typedef {object} ProjectProbe     The git work tree turns ran in: `{ root, head, diff }` against `base` (the commit
 *                                      a range began on, else HEAD), or `{ diff_omitted }` when it cannot be rebuilt;
 *                                      `head`, the commit a turn begins on. Null outside a repository.
 * @property {(dir: string, options?: { base?: string|null }) => Promise<{ root: string, head: string, diff: string }|{ diff_omitted: string }|null>} snapshot
 * @property {(dir: string) => Promise<{ root: string, head: string }|null>} head
 *
 * @typedef {object} Scheduler          Slow work the caller must not wait for.
 * @property {(tasks: ('engine'|'drain'|'distill')[]) => void} schedule
 * @property {(at: number, tasks: ('engine'|'drain'|'distill')[]) => void} wakeAt  Runs `tasks` once `at` (epoch ms)
 *   has passed, with no event to start them; a wake-up later than the one already armed is dropped.
 * @property {() => Promise<void>} [idle]  Resolves once scheduled work is done, where it runs in this process.
 * @property {(work: () => Promise<unknown>) => void} [alongside]  Runs `work` in this process without holding up the
 *   tasks scheduled after it; absent where a process lives only for its own batch.
 *
 * @typedef {object} Clock
 * @property {() => number} now
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} sleep
 *
 * @typedef {object} Engine             Evolver itself: whether it needs setting up, setting it up, and its outcome.
 * @property {() => Promise<boolean>} needsSetup
 * @property {() => Promise<void>} setUp
 * @property {() => Promise<void>} retryNow  Drops a failed setup's retry delay, so the next setup runs at once.
 * @property {() => Promise<object|null>} outcome
 * @property {() => Promise<object|null>} takeUnannounced  The latest outcome once, then null until it changes.
 *
 * @typedef {object} SignInRun          One background `evolver login`: when it started, whether it still runs, what
 *                                      it printed so far, and where its output is kept.
 * @property {number} startedAt
 * @property {boolean} isRunning
 * @property {string} output
 * @property {string} log
 *
 * @typedef {object} SignIn             Evolver's device sign-in to the Hub, run in the background; one at a time.
 * @property {() => Promise<SignInRun|null>} latest
 * @property {(isKept: (run: SignInRun|null) => boolean) => Promise<SignInRun|null>} joinOrStart  The latest run
 *   when `isKept(run)`, else a new one; decided under a lock, so concurrent callers share one run. Null when another
 *   process holds the lock and shows no run, which a process killed while starting one leaves for a while.
 * @property {(run: SignInRun) => Promise<void>} forget  Drops that run once its answer was given.
 *
 * @typedef {object} LocalLedger
 * @property {() => Promise<void>} load  Loads evolver-core ahead of `record`, which then runs without a slow import.
 * @property {(entry: { assetId, outcome, sessionId }) => Promise<boolean>} record
 *
 * @typedef {object} EvolverCli
 * @property {(args: string[], options?: { cwd?: string|null, signal?: AbortSignal }) => Promise<{ ok: boolean, text: string }>} run
 *
 * @typedef {object} Settings           What the person chose: EVOLVER_RECALL=off turns recall off,
 *                                      EVOLVER_AUTO_DISTILL=off background distillation (it still runs on demand).
 * @property {boolean} recall
 * @property {boolean} autoDistill
 *
 * @typedef {object} Ports
 * @property {Identity} identity
 * @property {SessionStore} sessions
 * @property {TurnNotes} notes
 * @property {EditBaseline} baseline
 * @property {TableStore & { referenceOf: (sessionId: string, range: object) => string }} candidates
 * @property {TableStore} drafts
 * @property {TableStore} outcomes
 * @property {TableStore} corpus
 * @property {DraftCorrections} draftCorrections
 * @property {ReportQueue} reports
 * @property {Outbox} outbox
 * @property {RetentionStore} retention
 * @property {Proxy} proxy
 * @property {ModelRunner|null} model
 * @property {OwnerProbe} owner
 * @property {ProjectProbe} project
 * @property {Scheduler} scheduler
 * @property {Clock} clock
 * @property {Engine} engine
 * @property {LocalLedger} ledger
 * @property {EvolverCli} cli
 * @property {SignIn} signIn
 * @property {Settings} settings
 */

export const TASKS = Object.freeze({ ENGINE: 'engine', DRAIN: 'drain', DISTILL: 'distill' });

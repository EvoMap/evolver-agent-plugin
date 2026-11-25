// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { CHANNELS } from '../../agent/events.js';
import { profileNamed } from '../../agent/registry.js';
import { arrivedLateStatusOf, recallStatusOf, RECALLING_STATUS, unreportedTurnNoticeOf } from '../../recall-status.js';
import { ownerIsGone } from '../../runtime/process/owner.js';
import { createPluginChannel } from '../plugin/adapter.js';
import { createModelQueue } from './model-queue.js';

const HOST = '127.0.0.1';
const MODEL_POLL_MS = 20_000;
const PARENT_POLL_MS = 5_000;
const BODY_MAX_BYTES = 4 * 1024 * 1024;
const MAX_LATE = 64;
const JOIN_WAIT_MS = 2_000;

function bodyOf(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_MAX_BYTES) request.destroy(new Error('request too large'));
      else chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function isAuthorized(request, token) {
  const given = Buffer.from(String(request.headers.authorization ?? ''));
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const reply = (response, status, value) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value ?? null));

const turnKeyOf = (payload) => (payload?.turn_id ? JSON.stringify([payload.session_id ?? null, payload.turn_id]) : null);

// Each recalled-for turn ends with a notice of what its recall did. A turn that reported a strategy has its summary;
// any other is told here, from the recall's trace as it stood when the turn ended and whether a model step carried
// what it injected. A turn is keyed by its session as well, and one whose strategy is being joined waits for the join's
// answer, so a join still in flight is not told as unused; a join that has not answered within a short wait is told
// as injected, since it may yet succeed.
function turnRecalls() {
  const turns = new Map();
  return {
    started(turnKey, traced) {
      const turn = { trace: null, isSettled: false, isJoined: false, joining: null };
      traced.then((trace) => Object.assign(turn, { trace, isSettled: true }), () => Object.assign(turn, { isSettled: true }));
      turns.set(turnKey, turn);
      if (turns.size > MAX_LATE) turns.delete(turns.keys().next().value);
    },
    joining(turnKey, joined) {
      const turn = turns.get(turnKey);
      if (turn) turn.joining = joined.then((isJoined) => { turn.isJoined ||= isJoined; }, () => {});
    },
    async ended(turnKey) {
      const turn = turns.get(turnKey);
      turns.delete(turnKey);
      if (!turn) return null;
      const joinedInTime = turn.joining && await Promise.race([turn.joining.then(() => true), new Promise((resolve) => setTimeout(resolve, JOIN_WAIT_MS, false).unref())]);
      if (turn.joining && !joinedInTime) turn.isJoined = true;
      return unreportedTurnNoticeOf(turn);
    },
  };
}

// A recall slower than the prompt's wait answers later: the module asks for it by id, and gets it only while its turn
// is still open, then joins it to the turn once a model step carries it, which books it only while that turn is open.
// A module that asks `withStatus` also gets the status line of what the recall decided, even when it brought nothing to
// add; one that does not (a module older than the status line, beside a newer relay) gets only a strategy, as before.
function lateBook(turns) {
  const entries = new Map();
  const remember = (value) => {
    const id = randomUUID();
    entries.set(id, value);
    if (entries.size > MAX_LATE) entries.delete(entries.keys().next().value);
    return id;
  };
  return {
    held: (late, traced, turnKey) => remember({ late, traced, turnKey }),
    async landed(id, { withStatus = false } = {}) {
      const entry = entries.get(id);
      const landed = await entry?.late;
      const isTraced = withStatus && Boolean(entry?.traced);
      const trace = isTraced ? await entry.traced : null;
      entries.delete(id);
      const status = isTraced ? recallStatusOf(trace) : null;
      if (!landed) return status ? { status } : null;
      if (!(await landed.show())) return withStatus ? { status: arrivedLateStatusOf(trace?.name) } : null;
      return { id: remember({ join: landed.join, turnKey: entry.turnKey }), text: landed.text, ...(status && { status }) };
    },
    async joined(id) {
      const entry = entries.get(id);
      entries.delete(id);
      const join = entry?.join ? entry.join() : Promise.resolve(false);
      if (entry?.join) turns.joining(entry.turnKey, join);
      return { joined: await join };
    },
  };
}

/**
 * The relay channel: for a host whose plugin code runs where Node does not (Claude Code's hooks modules), the
 * module starts this process and sends it each host event over loopback HTTP, with the token this process printed.
 * Here the plugin channel runs as for any in-process host; the module applies the answers, and runs the model
 * completions this process queues, since only the module holds the session's model.
 */
export function createRelay({ profile, env = process.env, token = randomBytes(24).toString('hex') }) {
  const models = createModelQueue();
  const channel = createPluginChannel({ profile, env, overrides: { model: models.port } });
  const turns = turnRecalls();
  const lates = lateBook(turns);
  const routes = {
    '/event': async ({ hostEvent, payload }) => {
      const { late, traced, ...answer } = await channel.handle(hostEvent, payload);
      const turnKey = turnKeyOf(payload);
      if (traced && turnKey) turns.started(turnKey, traced);
      if (hostEvent === 'turn.complete' && turnKey) {
        const notice = await turns.ended(turnKey);
        return !answer.text && notice ? { ...answer, text: notice } : answer;
      }
      return late ? { ...answer, late: lates.held(late, traced, turnKey), ...(traced && { status: RECALLING_STATUS }) } : answer;
    },
    '/late': ({ id, withStatus }) => lates.landed(id, { withStatus: withStatus === true }),
    '/late/join': ({ id }) => lates.joined(id),
    '/model/next': ({ waitMs }) => models.next(Math.min(Number(waitMs) || MODEL_POLL_MS, MODEL_POLL_MS)),
    '/model/answer': (outcome) => ({ taken: models.answer(outcome) }),
  };
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !isAuthorized(request, token)) return reply(response, 401, { error: 'unauthorized' });
    const route = routes[new URL(request.url, `http://${HOST}`).pathname];
    if (!route) return reply(response, 404, { error: 'not found' });
    try {
      reply(response, 200, await route(await bodyOf(request)));
    } catch (error) {
      reply(response, 500, { error: String(error?.message ?? error) });
    }
  });
  return {
    token,
    listen: () => new Promise((resolve) => server.listen(0, HOST, () => resolve(server.address().port))),
    close: () => {
      channel.close();
      server.close();
      server.closeAllConnections();
    },
  };
}

/** Runs the relay for `agent` until the process that started it is gone, printing one line, `{ port, token }`, once it listens. */
export async function runRelayProcess(agent, { env = process.env, stdout = process.stdout } = {}) {
  const profile = await profileNamed(agent);
  if (!profile) throw new Error(`No agent named "${agent}".`);
  if (profile.channel !== CHANNELS.RELAY) throw new Error(`"${agent}" is not a relayed agent: it connects through its own ${profile.channel} channel.`);
  const relay = createRelay({ profile, env });
  const port = await relay.listen();
  stdout.write(`${JSON.stringify({ port, token: relay.token })}\n`);
  const parent = process.ppid;
  const shutDown = () => {
    relay.close();
    process.exit(0);
  };
  setInterval(() => ownerIsGone(parent) && shutDown(), PARENT_POLL_MS).unref();
  process.on('SIGTERM', shutDown);
  return relay;
}

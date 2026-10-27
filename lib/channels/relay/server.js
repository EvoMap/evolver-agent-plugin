// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { CHANNELS } from '../../agent/events.js';
import { profileNamed } from '../../agent/registry.js';
import { ownerIsGone } from '../../runtime/process/owner.js';
import { createPluginChannel } from '../plugin/adapter.js';
import { createModelQueue } from './model-queue.js';

const HOST = '127.0.0.1';
const MODEL_POLL_MS = 20_000;
const PARENT_POLL_MS = 5_000;
const BODY_MAX_BYTES = 4 * 1024 * 1024;
const MAX_LATE = 64;

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

// A recall slower than the prompt's wait answers later: the module asks for it by id, and gets it only while its turn
// is still open, then joins it to the turn once a model step carries it, which books it only while that turn is open.
function lateBook() {
  const entries = new Map();
  const remember = (value) => {
    const id = randomUUID();
    entries.set(id, value);
    if (entries.size > MAX_LATE) entries.delete(entries.keys().next().value);
    return id;
  };
  return {
    held: (late) => remember({ late }),
    async landed(id) {
      const landed = await entries.get(id)?.late;
      entries.delete(id);
      if (!landed || !(await landed.show())) return null;
      return { id: remember({ join: landed.join }), text: landed.text };
    },
    async joined(id) {
      const join = entries.get(id)?.join;
      entries.delete(id);
      return { joined: join ? await join() : false };
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
  const lates = lateBook();
  const routes = {
    '/event': async ({ hostEvent, payload }) => {
      const { late, ...answer } = await channel.handle(hostEvent, payload);
      return late ? { ...answer, late: lates.held(late) } : answer;
    },
    '/late': ({ id }) => lates.landed(id),
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

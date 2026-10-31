// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nodeExecutable } from './process/node.js';
import { ownerIsGone } from './process/owner.js';
import { startLogged } from './process/spawn.js';
import { withLock, writeState } from './store/file-lock.js';

const WORKER = fileURLToPath(new URL('../../bin/worker.mjs', import.meta.url));
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const MAX_RESULT = 16_000;
const MAX_HISTORY_BYTES = 512 * 1024;
const DEADLINE_MS = 12 * 60 * 1000;

const answer = (ok, text) => ({ ok, text });
const displayed = job => `Job ${job.id}: ${job.name} — ${job.state}.${job.text ? `\n${job.text}` : ''}`;

/** One admitted command per host, with durable results and cancellation owned by its live worker. */
export function commandJobsOf({ dir, agent, env, accepts, start = startLogged, isGone = ownerIsGone }) {
  const file = join(dir, 'commands.json');
  const lock = join(dir, 'commands.lock');
  const read = () => {
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('invalid file');
      const jobs = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(jobs) || jobs.length > 20 || jobs.some(job => !ID.test(job?.id ?? '') || !accepts(job.name)
        || typeof job.args !== 'string' || job.args.length > 16_000 || typeof job.sessionId !== 'string' || !job.sessionId || job.sessionId.length > 256 || typeof job.projectDir !== 'string'
        || !['queued', 'running', 'cancelling', 'completed', 'cancelled', 'failed', 'interrupted'].includes(job.state)
        || (ACTIVE.has(job.state) && (!Number.isSafeInteger(job.pid) || job.pid <= 0)))) throw new Error('invalid state');
      return jobs;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error('Command state is unreadable; inspect the private commands.json before starting another command.');
    }
  };
  const refresh = jobs => jobs.map(job => ACTIVE.has(job.state) && job.pid && isGone(job.pid)
    ? { ...job, state: 'interrupted', text: 'The worker exited without a result. Inspect the operation before retrying; it was not replayed.' } : job);
  const change = async mutate => {
    let result = answer(false, 'Command state is busy; try again.');
    for (let attempt = 0; attempt < 100; attempt++) {
      const held = await withLock(lock, async () => {
        const jobs = refresh(read());
        result = await mutate(jobs);
        const kept = jobs.slice(-20);
        while (kept.length > 1 && Buffer.byteLength(JSON.stringify(kept)) > MAX_HISTORY_BYTES) kept.shift();
        writeState(file, kept);
      });
      if (held) return result;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return result;
  };
  return {
    enqueue: at => change(async jobs => {
      if (!accepts(at.name) || typeof at.args !== 'string' || at.args.length > 16_000 || typeof at.sessionId !== 'string' || !at.sessionId || at.sessionId.length > 256 || typeof at.projectDir !== 'string') return answer(false, 'Invalid background command.');
      const active = jobs.find(job => ACTIVE.has(job.state));
      if (active) return answer(false, `Job ${active.id} is still ${active.state}; inspect or cancel it before starting another command.`);
      const job = { id: randomUUID(), name: at.name, args: at.args, sessionId: at.sessionId, projectDir: at.projectDir, state: 'queued', at: Date.now() };
      jobs.push(job);
      // Hold admission until the process exists; its worker claims the same lock before doing any work.
      try {
        const started = await start(nodeExecutable(), [WORKER, agent, `command:${job.id}`], { env, logFile: join(dir, 'worker.log') });
        if (!started.pid) throw new Error('worker missing');
        job.pid = started.pid;
      } catch { job.state = 'failed'; job.text = 'The command worker could not start; no command ran.'; }
      return answer(job.state === 'queued', `${displayed(job)}\nUse evolver-status job ${job.id} for the result, or evolver-status cancel ${job.id}.`);
    }),
    status: id => change(jobs => {
      if (id && !ID.test(id)) return answer(false, 'Invalid command job id.');
      const chosen = id ? jobs.filter(job => job.id === id) : jobs.slice(-5);
      return answer(chosen.length > 0 || !id, chosen.length ? chosen.map(displayed).join('\n\n') : 'No command jobs found.');
    }),
    cancel: id => change(jobs => {
      const job = ID.test(id ?? '') && jobs.find(item => item.id === id);
      if (!job) return answer(false, 'No command job matches that id.');
      if (ACTIVE.has(job.state)) job.state = job.state === 'queued' ? 'cancelled' : 'cancelling';
      return answer(true, `${displayed(job)}\nCancellation stops the active request; completed side effects are not undone.`);
    }),
    async run(id, execute) {
      if (!ID.test(id)) return false;
      let claimed;
      await change(jobs => {
        const job = jobs.find(item => item.id === id);
        if (job?.state !== 'queued' || job.pid !== process.pid) return false;
        job.state = 'running'; claimed = { ...job };
      });
      if (!claimed) return false;
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(new Error('Command exceeded its execution budget.')), DEADLINE_MS);
      const poll = setInterval(() => {
        try {
          const job = read().find(item => item.id === id);
          if (!job || job.state === 'cancelling') controller.abort(new Error('Command cancelled.'));
        } catch { controller.abort(new Error('Command state became unreadable.')); }
      }, 200);
      let result;
      try { result = await execute(claimed, controller.signal); }
      catch { result = answer(false, 'Command failed; no automatic retry was made.'); }
      finally { clearInterval(poll); clearTimeout(deadline); }
      await change(jobs => {
        const job = jobs.find(item => item.id === id);
        if (!job || job.pid !== process.pid) return;
        const cancelled = job.state === 'cancelling';
        job.state = cancelled ? 'cancelled' : controller.signal.aborted ? 'failed' : result?.ok ? 'completed' : 'failed';
        job.text = `${controller.signal.aborted ? `${controller.signal.reason.message}\n` : ''}${String(result?.text ?? '')}`.slice(0, MAX_RESULT);
        job.finishedAt = Date.now();
      });
      return true;
    },
  };
}

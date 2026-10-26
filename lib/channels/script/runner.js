// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { runBackgroundTasks } from '../../app/background.js';
import { createDriver } from '../../agent/driver.js';
import { profileNamed } from '../../agent/registry.js';
import { EPHEMERAL, environmentFor } from '../../runtime/environment.js';
import { transcripts } from '../../runtime/transcripts.js';

/** The host events a command script raises; an agent whose commands are scripts maps them to canonical events. */
export const SCRIPT_EVENTS = Object.freeze({ COMMAND: 'Command', AGENT_GENE: 'AgentGene' });

const SCRIPT = fileURLToPath(new URL('../../../bin/command.mjs', import.meta.url));
const POST_FLAG = '--post';

function readAll(stdin) {
  if (stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let text = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => { text += chunk; });
    stdin.on('end', () => resolve(text));
    stdin.on('error', () => resolve(text));
  });
}

/**
 * The channel of a host whose commands run as shell scripts rather than through a hook: the command's arguments
 * arrive on stdin (a heredoc, so the host's raw substitution cannot break out into the shell), the session is
 * whatever the agent's `commands.sessionOf(env)` names, and the answer is printed for the agent to show.
 * `--post <writtenFor>` hands over a Gene the agent's own model wrote. Each payload carries this script's path and
 * a fresh nonce, so an answer may tell the agent how to call the script again safely.
 */
export async function runCommandScript(agent, name, { argv = [], stdin = process.stdin, stdout = process.stdout, env = process.env, exit = process.exit, profileOf = profileNamed } = {}) {
  const write = (answer) => stdout.write(typeof answer === 'string' ? answer : JSON.stringify(answer ?? {}), () => exit(0));
  const profile = await profileOf(agent).catch(() => null);
  if (!profile) return write(`No agent named "${agent}".`);
  const text = (await readAll(stdin)).trim();
  const postAt = argv.indexOf(POST_FLAG);
  const base = { session_id: profile.commands.sessionOf?.(env) ?? env.EVOLVER_SESSION_ID ?? '', script: SCRIPT, nonce: randomBytes(8).toString('hex') };
  const [hostEvent, payload] = postAt >= 0
    ? [SCRIPT_EVENTS.AGENT_GENE, { ...base, gene: text, written_for: argv[postAt + 1] }]
    : [SCRIPT_EVENTS.COMMAND, { ...base, prompt: `/${name}${text ? ` ${text}` : ''}` }];
  const { ports } = environmentFor({ profile, env, lifetime: EPHEMERAL, runBackground: runBackgroundTasks });
  return write(await createDriver({ profile, ports, transcripts, lifetime: EPHEMERAL }).handle(hostEvent, payload));
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { runBackgroundTasks } from '../../app/background.js';
import { COMMANDS, commandNamed } from '../../app/commands/index.js';
import { createDriver } from '../../agent/driver.js';
import { profileNamed } from '../../agent/registry.js';
import { EPHEMERAL, environmentFor } from '../../runtime/environment.js';
import { transcripts } from '../../runtime/transcripts.js';

const SCRIPT = fileURLToPath(new URL('../../../bin/command.mjs', import.meta.url));
const POST_FLAG = '--post';
// A command run from a terminal belongs to no session; it reads the agent's state as a whole.
export const TERMINAL_SESSION = 'terminal';

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
 * The channel of a host whose commands run as scripts rather than through a hook (WorkBuddy's inline command
 * scripts, a terminal): `bin/command.mjs <agent> <command> [args…]`, the arguments on the command line or on stdin
 * (a heredoc, which a host's raw substitution cannot break out of). The channel reads its own input: the session is
 * the agent's `commands.sessionOf(env)`, else EVOLVER_SESSION_ID, else none (then a distill acts on the newest
 * candidate), and the project is the directory the script runs in. `--post <writtenFor>` hands over a Gene the
 * agent's own model wrote. The answer is the agent's `commands.scriptAnswer(result, script)`, printed as text;
 * `script` carries the session it named (null from a terminal), this script's path, a fresh nonce and the state
 * folder, for an answer that tells the agent how to call the script again.
 */
function usageOf(agent, name) {
  const lines = COMMANDS.map((command) => `  ${command.name}${command.hint ? ` ${command.hint}` : ''}  ${command.description}`);
  return [`${name ? `Unknown command ${name}. ` : ''}Usage: node bin/command.mjs ${agent} <command> [arguments]`, ...lines].join('\n');
}

export async function runCommandScript(agent, name, { argv = [], stdin = process.stdin, stdout = process.stdout, env = process.env, exit = process.exit, profileOf = profileNamed } = {}) {
  const write = (text) => stdout.write(String(text ?? ''), () => exit(0));
  const profile = await profileOf(agent).catch(() => null);
  if (!profile) return write(`No agent named "${agent}".`);
  const postAt = argv.indexOf(POST_FLAG);
  if (postAt < 0 && !commandNamed(name)) return write(usageOf(agent, name));
  const commandLine = (postAt >= 0 ? argv.slice(0, postAt) : argv).join(' ').trim();
  // stdin is read only where something is written to it: a posted Gene, or the arguments an inline-script host's
  // command file passes in a heredoc. Any other caller, a terminal included, may hold it open and never write.
  const hasArgumentsOnStdin = profile.commands.entry === 'inline-script' && Boolean(commandNamed(name).hint) && !stdin.isTTY;
  const takesInput = postAt >= 0 || hasArgumentsOnStdin;
  const input = profile.commands.scriptArgs(commandLine || (takesInput ? (await readAll(stdin)).trim() : ''));
  const named = profile.commands.sessionOf?.(env) || env.EVOLVER_SESSION_ID || null;
  const at = { sessionId: named ?? TERMINAL_SESSION, projectDir: process.cwd(), anySession: !named };
  const script = { session_id: named, state_dir: profile.stateDir(env), script: SCRIPT, nonce: randomBytes(8).toString('hex') };
  const { ports } = environmentFor({ profile, env, lifetime: EPHEMERAL, runBackground: runBackgroundTasks });
  const driver = createDriver({ profile, ports, transcripts, env, lifetime: EPHEMERAL });
  const result = postAt >= 0
    ? await driver.direct(at, { gene: input, writtenFor: Number(argv[postAt + 1]) })
    : await driver.direct(at, { command: { name, args: input } });
  return write(profile.commands.scriptAnswer(result, script));
}

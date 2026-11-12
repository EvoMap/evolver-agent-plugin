import { join } from 'node:path';

const KEYS = ['HOME', 'USERPROFILE', 'EVOLVER_HOME', 'EVOMAP_HOME'];

/**
 * Points this process's home and Evolver home at `home` until `restore()`. A resident host's ledger thread and its
 * evolver-core read the process environment, never the `env` its ports were built with, so a fixture home passed only
 * as `env` leaves the reuse records in the developer's own `~/.evomap`. `env` carries the same values for the ports.
 */
export function useProcessHome(home) {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const env = { HOME: home, USERPROFILE: home, EVOLVER_HOME: join(home, '.evomap') };
  delete process.env.EVOMAP_HOME;
  Object.assign(process.env, env);
  return {
    env,
    rootEventsPath: join(env.EVOLVER_HOME, 'evolution', 'root_events.jsonl'),
    restore: () => {
      for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    },
  };
}

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';

const credentialOf = (data) => data.provider.key_env
  ? { kind: 'api-key', env: data.provider.key_env }
  : { kind: 'api-key', value: data.provider.key };

// The Windows job helper compiles its Win32 bridge with Add-Type before the native client starts; on a cold CI runner
// that alone can take longer than 10 s.
export const COMPLETION_BUDGET_MS = 60_000;

/** The model a turn's end captures for the fixture route, as a host's `turnEnd.modelOf` would. */
export const capturedModel = (runner, { alias, effort = null }) => ({
  selection: { alias, model: 'fixture-model', protocol: 'openai', effort }, configDigest: runner.configStamp(),
});

export function declarationFor(config, receipt, mode = '') {
  return {
    kind: 'acp', command: () => process.execPath,
    args: () => [fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))],
    config: {
      source: () => config,
      parseConfig: parse,
      serializeConfig: JSON.stringify,
      select: (data, hint) => ({
        route: { alias: hint.alias, providerId: 'fixture', model: 'fixture-model', protocol: 'openai', endpoint: data.provider.endpoint, ...(hint.effort ? { effort: hint.effort } : {}) },
        credential: credentialOf(data),
      }),
      credentials: (data) => [credentialOf(data)],
    },
    sessionConfig: snapshot => snapshot.effort ? [{ id: 'thinking', value: snapshot.effort }] : [],
    prepare: (selected, { credentialEnv }) => ({
      files: { 'fixture.json': { format: 'config', value: { ...selected.route, credentialEnv, mode } } },
      env: { FIXTURE_RECEIPT: receipt },
    }),
    facts: { root: home => join(home, 'records'), logName: 'wire.jsonl', decode: records => records.at(-1) },
  };
}

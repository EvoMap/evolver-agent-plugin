import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function declarationFor(config, receipt, mode = '') {
  return {
    kind: 'acp', command: () => process.execPath,
    args: () => [fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))],
    config: {
      source: () => config,
      select: (data, hint) => ({
        route: { alias: hint.alias, providerId: 'fixture', model: 'fixture-model', protocol: 'openai', endpoint: data.provider.endpoint, ...(hint.effort ? { effort: hint.effort } : {}) },
        credential: data.provider.key_env ? { kind: 'api-key', env: data.provider.key_env } : { kind: 'api-key', value: data.provider.key },
      }),
    },
    sessionConfig: snapshot => snapshot.effort ? [{ id: 'thinking', value: snapshot.effort }] : [],
    prepare: (selected, { credentialEnv }) => ({
      files: { 'fixture.json': { format: 'text', value: JSON.stringify({ ...selected.route, credentialEnv, mode }) } },
      env: { FIXTURE_RECEIPT: receipt },
    }),
    facts: { root: home => join(home, 'records'), decode: records => records.at(-1) },
  };
}

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

import { candidateOf } from '../../../lib/distill/candidate.js';
import { fileStoresOf } from '../../../lib/runtime/store/file-stores.js';
import { GENE, PROMPT, projectDirectory, requestsTo, startProxy, until } from './host.js';

function fakeTuiClient() {
  const calls = [];
  const record = (name) => async (parameters) => {
    calls.push({ name, parameters });
    return { data: {} };
  };
  return {
    calls,
    session: {
      create: async (parameters) => {
        calls.push({ name: 'create', parameters });
        return { data: { id: 'ses_helper', ...parameters } };
      },
      update: record('update'),
      abort: record('abort'),
      delete: record('delete'),
      prompt: async (parameters) => {
        calls.push({ name: 'prompt', parameters });
        return { data: { info: { role: 'assistant', tokens: { input: 10, output: 5 } }, parts: [{ type: 'text', text: GENE }] } };
      },
    },
  };
}

function fakeApi({ route = { name: 'home' }, directory = projectDirectory() } = {}) {
  const shown = [];
  const layers = [];
  return {
    shown,
    layers,
    client: fakeTuiClient(),
    route: { current: route },
    state: { path: { directory } },
    lifecycle: { signal: new AbortController().signal },
    keymap: { registerLayer: (layer) => { layers.push(layer); return () => {}; } },
    ui: {
      toast: () => {},
      DialogAlert: (props) => ({ kind: 'alert', ...props }),
      DialogPrompt: (props) => ({ kind: 'prompt', ...props }),
      dialog: { replace: (render) => shown.push(render()), clear: () => {} },
    },
  };
}

async function loadTui(api, options = {}) {
  const { default: plugin } = await import('../../../hosts/opencode/dist/tui.mjs');
  assert.equal(plugin.id, 'evomap.evolver');
  await plugin.tui(api, options);
  return Object.fromEntries(api.layers[0].commands.map((command) => [command.slashName, command]));
}

const lastAlert = (api) => api.shown.filter((dialog) => dialog.kind === 'alert').at(-1);
const inSession = (sessionID) => ({ route: { name: 'session', params: { sessionID } } });

test('every /evolver-* command but the evolve prompt is a palette command with a slash name', async (t) => {
  await startProxy(t);
  const commands = await loadTui(fakeApi());
  assert.deepEqual(Object.keys(commands).sort(), [
    'evolver-distill', 'evolver-drafts', 'evolver-review', 'evolver-run', 'evolver-search', 'evolver-solidify', 'evolver-status', 'evolver-sync',
  ]);
  for (const command of Object.values(commands)) {
    assert.equal(command.namespace, 'palette');
    assert.equal(command.category, 'Evolver');
    assert.equal(command.title, `/${command.slashName}`);
    assert.equal(command.name, `evomap.${command.slashName}`);
  }
});

test('a command without input runs at once and answers in a dialog', async (t) => {
  const proxy = await startProxy(t);
  const api = fakeApi();
  (await loadTui(api))['evolver-status'].run();
  await until(() => lastAlert(api), 'the status dialog');
  assert.equal(api.shown.some((dialog) => dialog.kind === 'prompt'), false);
  assert.equal(lastAlert(api).title, '/evolver-status');
  assert.ok(requestsTo(proxy, '/proxy/status').length > 0);
});

test('/evolver-search asks for its text, shows the strategy and hands it to the open session as hidden text', async (t) => {
  await startProxy(t);
  const api = fakeApi(inSession('ses_open'));
  (await loadTui(api))['evolver-search'].run();
  const ask = api.shown.at(-1);
  assert.equal(ask.kind, 'prompt');
  assert.equal(ask.placeholder, '<task description or error text>');
  ask.onConfirm(PROMPT);
  await until(() => lastAlert(api), 'the search result');
  assert.match(lastAlert(api).message, /Apply them where they fit\.$/);
  const [handed] = api.client.calls.filter((call) => call.name === 'prompt');
  assert.equal(handed.parameters.sessionID, 'ses_open');
  assert.equal(handed.parameters.noReply, true);
  assert.deepEqual(handed.parameters.parts, [{ type: 'text', text: lastAlert(api).message, synthetic: true }]);
});

test('/evolver-search and /evolver-distill need an open session', async (t) => {
  await startProxy(t);
  const api = fakeApi();
  (await loadTui(api))['evolver-search'].run();
  api.shown.at(-1).onConfirm(PROMPT);
  await until(() => lastAlert(api), 'the refusal');
  assert.match(lastAlert(api).message, /^Open a session first/);
  assert.equal(lastAlert(api).title, '/evolver-search failed');
});

test("/evolver-distill distills the open session's candidate now, through a helper session", async (t) => {
  const proxy = await startProxy(t);
  const stores = fileStoresOf({ dir: proxy.stateDir, agent: 'opencode' });
  const record = { checks: [{ command: 'npm test', failed: false }], commands: ['npm test'], paths: [], edits: ['a.js'], answer: 'Done.' };
  await stores.candidates.update(() => ({ ses_open: candidateOf({ prompt: PROMPT, record, model: { providerID: 'anthropic', modelID: 'claude-sonnet' }, turn: 1, pid: process.pid, now: 1 }) }));

  const api = fakeApi(inSession('ses_open'));
  (await loadTui(api))['evolver-distill'].run();
  api.shown.at(-1).onConfirm('the retry option');
  await until(() => lastAlert(api), 'the distillation');
  assert.match(lastAlert(api).message, /^Distilled "Stabilise Redis retries" into a draft/);
  const prompt = api.client.calls.find((call) => call.name === 'prompt').parameters;
  assert.equal(prompt.sessionID, 'ses_helper');
  assert.match(prompt.parts[0].text, /Focus on: the retry option/);
  assert.deepEqual(await stores.candidates.read(), {});
});

test('the engine commands run the evolver CLI in the project, with quoted arguments kept whole', async (t) => {
  await startProxy(t);
  const bin = mkdtempSync(join(tmpdir(), 'evolver-opencode-bin-'));
  const log = join(bin, 'calls.log');
  writeFileSync(join(bin, 'evolver'), `#!/bin/sh\nprintf '%s|' "$(pwd)" "$@" >> "${log}"\necho solidified\n`);
  chmodSync(join(bin, 'evolver'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  t.after(() => { process.env.PATH = path; });

  const directory = projectDirectory();
  const api = fakeApi({ directory });
  (await loadTui(api))['evolver-solidify'].run();
  api.shown.at(-1).onConfirm('--dry-run --summary="two words"');
  await until(() => lastAlert(api), 'the CLI result');
  assert.equal(lastAlert(api).message, 'solidified');
  assert.equal(readFileSync(log, 'utf8'), `${directory}|solidify|--dry-run|--summary=two words|`);
});

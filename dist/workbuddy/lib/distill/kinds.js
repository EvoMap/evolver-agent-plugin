// SPDX-License-Identifier: MIT
// Copyright (c) 2026 EvoMap

import { errorEpisodesOf } from './gate.js';

export const KINDS = Object.freeze(['fix', 'change', 'investigate', 'configure', 'refactor']);

const CONFIG_FILE = new RegExp([
  '(?:^|/)\\.(?:github|gitlab|circleci|husky|devcontainer)/',
  '(?:^|/)(?:package(?:-lock)?\\.json|npm-shrinkwrap\\.json|pnpm-(?:lock|workspace)\\.yaml|yarn\\.lock|bun\\.lockb?)$',
  '(?:^|/)(?:tsconfig|jsconfig)[\\w.-]*\\.json$',
  '(?:^|/)(?:pyproject\\.toml|setup\\.(?:cfg|py)|requirements[\\w.-]*\\.txt|Pipfile(?:\\.lock)?|poetry\\.lock|uv\\.lock|tox\\.ini)$',
  '(?:^|/)(?:Cargo\\.(?:toml|lock)|go\\.(?:mod|sum)|Gemfile(?:\\.lock)?|pom\\.xml|build\\.gradle(?:\\.kts)?|settings\\.gradle(?:\\.kts)?)$',
  '(?:^|/)(?:Makefile|Dockerfile[\\w.-]*|docker-compose[\\w.-]*\\.ya?ml|compose\\.ya?ml|\\.gitlab-ci\\.yml|\\.gitignore|\\.dockerignore)$',
  '(?:^|/)\\.(?:eslintrc|prettierrc|babelrc|editorconfig|npmrc|nvmrc|node-version|python-version|tool-versions)[\\w.-]*$',
  '(?:^|/)[\\w-]+\\.config\\.[cm]?[jt]s$',
  '\\.(?:ya?ml|toml|ini|cfg|conf)$',
].join('|'));

export const isConfigFile = (path) => CONFIG_FILE.test(String(path));

/**
 * The session's kind, decided from its record alone: `fix` with a closed error episode, `investigate` with no edits,
 * `configure` when only configuration, manifest or CI files were edited, else `change`. `refactor` is left for the
 * model to choose.
 */
export function defaultKindOf(turns) {
  if (errorEpisodesOf(turns).closed.length > 0) return 'fix';
  const edited = turns.flatMap((turn) => turn.steps.filter((step) => step.kind === 'edit').map((step) => step.path));
  if (edited.length === 0) return 'investigate';
  return edited.every(isConfigFile) ? 'configure' : 'change';
}

const SUPPLEMENTS = {
  fix: [
    'This record fixes an error: a check failed, files were edited, and the same check passed.',
    '- Keep the symptom apart from the cause. The symptom is what the failed check printed (cite its check and output',
    '  lines); the cause is what the edits show was wrong. Write a cause only where the record confirms it, else put',
    '  it in unknowns.',
    '- Every failure_repair answers a failure the record shows: its signal is that failure\'s own text, its refs include',
    '  the failed check line, its verification is the later passing run of that check.',
    '- scope.signals start with the observed error text, shortened to what another project would also print.',
    '- Do not claim a regression test was added unless an edit line shows one.',
  ],
  change: [
    'This record changes behaviour: files were edited and checks ran, with no error fixed on the way.',
    '- Acceptance rests on the observed checks: name what they proved, not what you expect.',
    '- The procedure describes the change as a pattern another project can apply, in the order it was done.',
    '- Commands worth repeating exactly (the check that proved it, a generator, a migration) go into',
    '  canonical_contracts with their record line.',
    '- do_not_use_when names the setups where this change would be wrong or unnecessary.',
  ],
  investigate: [
    'This record investigates: commands and checks ran, but no file was edited.',
    '- Record how the search was narrowed: which command ruled out what, in order.',
    '- List the hypotheses the record ruled out, and keep those it did not settle in unknowns.',
    '- Do not claim anything was fixed: nothing was edited.',
    '- A command that revealed the answer belongs in canonical_contracts, copied from its line.',
  ],
  configure: [
    'This record configures: only configuration, manifest or CI files were edited.',
    '- The exact configuration syntax that made the check pass goes into canonical_contracts (kind config), copied',
    '  verbatim from its record line.',
    '- Differences between environments (OS, tool versions, CI runner, package manager) go into do_not_use_when.',
    '- preconditions name the tool and version range the configuration assumes, where the record shows them.',
  ],
};

/** What to stress for a record of `kind`, at most twenty lines. */
export const kindSupplementOf = (kind) => SUPPLEMENTS[kind] ?? SUPPLEMENTS.change;

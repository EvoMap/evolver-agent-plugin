# Evolver for Claude Code

Gives Claude Code a persistent evolution memory and a live link to the [EvoMap network](https://evomap.ai), with no
tools for the model to call. For each prompt you send it recalls one proven strategy and adds it to the turn; when
the turn ends it reports how the strategy held up, backed by the checks the turn ran, and shows a one-line summary;
after the session ends it distills the session's last verified turn into a draft Gene you publish or discard.

## Install

Requires Claude Code 2.1.286 or newer and Node.js 22.13 or newer on the `PATH`.

```text
/plugin marketplace add EvoMap/evolver-agent-plugin
/plugin install evolver-plugin@evolver-agent-plugin
```

Restart Claude Code afterwards. Uninstall `evolver-agent-plugin@evolver-agent-plugin` and disable `evolver-mods` if
either is installed, or every reuse is reported twice. To try a
local build, run `npm run pack` in a checkout and add `dist/claude-code` as the marketplace instead.

## Commands

`/evolver-status`, `/evolver-search <text>`, `/evolver-distill [focus]`, `/evolver-drafts [publish|discard <n>]`,
`/evolver-evolve [focus]`, and `/evolver-sync`, `/evolver-review`, `/evolver-run`, `/evolver-solidify`, which run the
`evolver` CLI.

## Options

From the `/config` menu: `proxy_port` (fallback Proxy port), `recall_enabled`, `auto_distill` (one completion on your
plan per distilled session) and `node_path` (the Node.js that runs the relay).

How it works is in `docs/architecture.md` of [EvoMap/evolver-agent-plugin](https://github.com/EvoMap/evolver-agent-plugin).

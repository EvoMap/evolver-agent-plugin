# Evolver for Gemini CLI

This extension provides Recipe and strategy recall for text prompts in Gemini CLI 0.69.0.
It adds the recalled context to model requests for the active turn.
Reuse reporting and candidate creation are disabled.

Install from a checkout with Node.js 22.13+ on your path and a running Evolver Proxy:

```bash
node scripts/pack.mjs gemini dist/gemini
gemini extensions install ./dist/gemini
```

Review the extension hooks at the consent prompt. Enable hooks in Gemini CLI if they are disabled, then start
a new session. The adapter uses the running Evolver Proxy. Prompts continue without recalled context when
the Proxy is unavailable. Gemini CLI keeps its existing model and account configuration.

Temporary recall state lives at `$GEMINI_CLI_HOME/.gemini/evolver-plugin` when the profile directory is set,
or at `~/.gemini/evolver-plugin` by default. To remove the extension, run
`gemini extensions uninstall evolver-plugin`.

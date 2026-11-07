# Evolver for ZCode

The same plugin folder works in ZCode CLI and Desktop on Windows. Node.js 22.13 or newer must be available to ZCode as `node`.

Add a local marketplace containing this plugin in Desktop Settings → Plugins, or use the CLI plugin marketplace commands. Enable the plugin and hooks, then start a new session.

Recipe recall runs in the prompt hook. The adapter observes foreground Bash calls and matches them to their native session and turn IDs. Reuse reports and candidates require an authoritative completion record from the same ZCode profile and fully resolved verification evidence. Cancelled or unconfirmed turns do not produce either. If the installed ZCode build does not expose a compatible read-only `turn_usage` record, recall still works.

On Windows the adapter can distill a verified turn with the ZCode CLI bundled with Desktop. It uses the turn's recorded provider, model and reasoning level and checks that the personal API-key configuration stayed stable. It supports personal OpenAI-compatible Chat Completions and Responses endpoints over HTTPS or loopback. It runs a single text request in a temporary profile with tools, plugins, MCP and hooks disabled. Configuration changes and unsupported routes (including OAuth) block background distillation rather than switching accounts.

To distill now, run `node <plugin-folder>/bin/command.mjs zcode evolver-distill` from a terminal with the same
configuration as the ZCode process that recorded the work:

- `ZCODE_PLUGIN_DATA` points to the running plugin's data directory.
- `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` points to the profile's personal provider configuration.
- `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` points to the profile's runtime provider file. Desktop keeps this file under
  `.zcode/v2/runtime/provider/`. The bundled `zcode-builtin.json` under the install directory can differ from it.

A configuration mismatch leaves the work pending and blocks distillation. Use `evolver-drafts` to view saved drafts.

# Evolver for ZCode CLI

Node.js 22.13 or newer must be available to ZCode as `node` on Windows. Build `dist/zcode` with `npm run pack`.

Follow the [ZCode CLI build guide](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/apps/zcode-cli/docs/usage/01-quickstart.md) to build a standalone `zcode.cjs` with its companion files. In `~/.zcode/cli/config.json`, append the absolute path to `dist/zcode` to `plugins.dirs`. Enable plugins and hooks, then start a new CLI session. Check the bundle with `node <absolute-zcode.cjs> plugins validate <absolute-plugin-folder> --json`.

Recipe recall runs in the prompt hook. The adapter observes foreground Bash calls and matches them to their native session and turn IDs. Reuse reports and candidates require an authoritative completion record from the same ZCode profile and fully resolved verification evidence. Cancelled or unconfirmed turns do not produce either. If the installed ZCode build does not expose a compatible read-only `turn_usage` record, recall still works.

For private distillation, set these variables in the environment that launches ZCode and in the terminal you use for Evolver commands:

- `ZCODE_CLI_PATH` is the absolute path to a trusted standalone `zcode.cjs` file. Keep its companion files in place.
- `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` points to the profile's active builtin provider configuration. Use the same file that your CLI build loads.
- `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` can override the CLI's default personal provider configuration.
- `ZCODE_PLUGIN_DATA` can identify the running plugin's data directory when ZCode sets it.

Run `node <plugin-folder>/bin/command.mjs zcode evolver-distill` from that terminal. The adapter sends one text request with the recorded provider, model and reasoning level. It checks that the personal API-key configuration stayed stable and runs in a temporary profile with tools, plugins, MCP and hooks disabled. Personal OpenAI-compatible Chat Completions and Responses endpoints must use HTTPS or loopback. A missing runtime, changed configuration or unsupported route such as OAuth blocks distillation.

Windows fixtures cover the standalone layout and protocol. Native model and Proxy acceptance used the CLI shipped with Desktop. An independently built standalone binary with a real provider is still unverified.

A configuration mismatch leaves the work pending and blocks distillation. Use `evolver-drafts` to view saved drafts.

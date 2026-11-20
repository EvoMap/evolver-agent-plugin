# Evolver for ZCode on Windows and macOS

Node.js 22.13 or newer must be available to ZCode as `node`. On macOS, ZCode Desktop imports the PATH of your login shell, so a `node` that your login shell finds is enough. Build `dist/zcode` with `npm run pack`.

## CLI

Use the CLI shipped with ZCode Desktop, or follow the [ZCode CLI build guide](https://github.com/zai-org/ZCode/blob/a9fe401eede6e6e5e01be9048679c206fe6f02d9/apps/zcode-cli/docs/usage/01-quickstart.md) to build a standalone `zcode.cjs` with its companion files. Desktop ships the CLI here:

- Windows: `%LOCALAPPDATA%/Programs/ZCode/resources/glm/zcode.cjs`
- macOS: `ZCode.app/Contents/Resources/glm/zcode.cjs`, under `~/Applications` or `/Applications`

To run the CLI shipped with macOS Desktop from a terminal, set `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` to the absolute path of `Contents/Resources/config/provider/zcode-builtin.json` inside the same app, for example `/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json`. A relative path is ignored.

Install the plugin from the EvoMap marketplace. ZCode reads it from GitHub and installs `dist/zcode` from the `release` branch, so `plugins update` follows each release:

```sh
node <absolute-zcode.cjs> plugins marketplace add https://raw.githubusercontent.com/EvoMap/evolver-agent-plugin/main/.zcode-plugin/marketplace.json
node <absolute-zcode.cjs> plugins install evolver-plugin@evomap --scope user
```

The manifest has its own URL because ZCode reads a repository's `.claude-plugin/marketplace.json` before any other, which here lists the Claude Code bundle.

To run a local build instead, add the packed folder (`plugins marketplace add <absolute-dist/zcode>`, then install `evolver-plugin@evolver-zcode-local`) or append its absolute path to `plugins.dirs` in `~/.zcode/cli/config.json`. Install only one of the two: both load the same hooks, so each prompt would be recalled and reported twice. Either way, set `plugins.enabled` and `hooks.enabled` to `true`, then start a new CLI session. Check the bundle with `node <absolute-zcode.cjs> plugins validate <absolute-plugin-folder> --json`.

Recipe recall runs in the prompt hook, which waits up to 10 s. A recall that misses that wait goes on in a background worker, and the turn's next `Bash`, `Write`, `Edit` or `ApplyPatch` result hands the strategy to the model as added context; a turn that runs no such tool after it lands never gets it, and it is not reported. The adapter observes foreground Bash calls and matches them to their native session and turn IDs. Reuse reports and candidates require an authoritative completion record from the same ZCode profile and fully resolved verification evidence. Cancelled or unconfirmed turns do not produce either. If the installed ZCode build does not expose a compatible read-only `turn_usage` record, recall still works.

For private distillation, set these variables in the environment that launches ZCode and in the terminal you use for Evolver commands:

- `ZCODE_CLI_PATH` is the absolute path to a trusted standalone `zcode.cjs` file. Keep its companion files in place.
- `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` points to the profile's active builtin provider configuration. Use the same file that your CLI build loads.
- `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` can override the CLI's default personal provider configuration.
- `ZCODE_PLUGIN_DATA` can identify the running plugin's data directory when ZCode sets it.

Run `node <plugin-folder>/bin/command.mjs zcode evolver-distill` from that terminal. The adapter sends one text request with the recorded provider, model and reasoning level. It checks that the personal API-key configuration stayed stable and runs in a temporary profile with tools, plugins, MCP and hooks disabled. Personal OpenAI-compatible Chat Completions and Responses endpoints must use HTTPS or loopback. A missing runtime, changed configuration or unsupported route such as OAuth blocks distillation.

Windows fixtures cover the standalone layout and protocol. Native model and Proxy acceptance used the CLI shipped with Windows Desktop. On macOS, ZCode 3.18.2 validated, installed and enabled the packed plugin; a model turn with a real provider is still unverified there, as is an independently built standalone binary.

## Desktop

In Settings → Plugins, add the marketplace URL `https://raw.githubusercontent.com/EvoMap/evolver-agent-plugin/main/.zcode-plugin/marketplace.json`, which registers `evomap`. Install `evolver-plugin` from it, enable the plugin and hooks, and start a new session. A local build works the same way from the absolute `dist/zcode` folder, which registers `evolver-zcode-local`. Desktop and CLI use the same hook adapter and package.

With `ZCODE_CLI_PATH` unset, distillation runs the CLI that Desktop ships, at the paths listed above. On macOS it tries `~/Applications` before `/Applications`. An explicit CLI path takes precedence. A nonempty invalid path blocks distillation. Set `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` to the provider configuration used by Desktop at runtime, typically under `.zcode/v2/runtime/provider/`. For a terminal distill command, also point `ZCODE_PLUGIN_DATA` to the active plugin data folder and use the same personal provider configuration as Desktop.

A configuration mismatch leaves the work pending and blocks distillation. Use `evolver-drafts` to view saved drafts.

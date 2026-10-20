# CLI pinning inventory

Facts about the `claude` (Claude Code) and `codex` (Codex CLI) command-line tools that Osen runs as participants. The goal is to let changes 175-182 pin exact CLI versions on facts instead of guesses. Change 176 (pinned install) reads the `## Decision` section at the end.

Everything here was gathered without a single model call, without a global install or update, and without signing in anywhere. The CLIs were installed only into a temporary prefix inside the project and removed afterwards.

## Status legend

Every value cell below starts with one of three words.

- `verified`: observed by a command or by reading code. The cell names the CLI version (or the Osen commit for code) and the date, for example `verified: claude 2.1.288, 2026-10-20, auth status`.
- `documented`: taken from a document. The cell names the URL and the read date.
- `not verified`: not proven. The cell names the reason.

Dates are 2026-10-20 unless stated. Osen code was read at commit c02ffe6. Paths under the home folder are written as `~/`. `$T` is the temporary folder of this inventory.

## Current binaries

State of the owner's machine on 2026-10-20 (macOS arm64).

| Item | Claude Code | Codex CLI |
|---|---|---|
| Install method | verified: claude 2.1.304, 2026-10-20, `npm ls -g --depth=0` lists `@anthropic-ai/claude-code@2.1.304`; `installMethod` in `~/.claude.json` is `global` | verified: codex-cli 0.159.2, 2026-10-20, standalone layout `~/.codex/packages/standalone/releases/0.159.2-aarch64-apple-darwin` with a `current` link and `codex-package.json` |
| Path on PATH | verified: claude 2.1.304, 2026-10-20, `command -v claude` is `/opt/homebrew/bin/claude`, a link to the npm package `bin/claude.exe` | verified: codex-cli 0.159.2, 2026-10-20, `command -v codex` is `~/.local/bin/codex`, a link to `~/.codex/packages/standalone/current/bin/codex` |
| Real binary | verified: claude 2.1.304, 2026-10-20, `/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, Mach-O arm64, 271161296 bytes | verified: codex-cli 0.159.2, 2026-10-20, `~/.codex/packages/standalone/releases/0.159.2-aarch64-apple-darwin/bin/codex`, Mach-O arm64, 240184096 bytes |
| Version | verified: claude 2.1.304, 2026-10-20, `claude --version` | verified: codex-cli 0.159.2, 2026-10-20, `codex --version` |
| sha256 | verified: claude 2.1.304, 2026-10-20, `shasum -a 256` gives `b9ac5374839f14abf3f1f45610637c332b5daee5ce0d1634726cef87aab78e6a` | verified: codex-cli 0.159.2, 2026-10-20, `shasum -a 256` gives `16593cc2f422d5f398a8e40f550ebbaf1245392528957be342c295920a300704` |
| Other versions on disk | not verified: not relevant to launches, only the PATH entry is used | verified: codex-cli 0.159.2, 2026-10-20, standalone releases 0.145.0, 0.154.0, 0.159.2; a second tree `~/.codex/packages/app-server-daemon` (desktop app) holds 0.159.2 to 0.162.1 with its own `current` link |
| Release source | documented: https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md, read 2026-10-20; npm dist-tags `latest`, `next`, `stable` are all 2.1.304 (verified: npm view, 2026-10-20, registry mirror `registry.npmmirror.com`) | verified: GitHub API `https://api.github.com/repos/openai/codex/releases/tags/rust-v<version>`, 2026-10-20 (rust-v0.159.2 published 2026-09-29, rust-v0.163.0 published 2026-10-15); npm dist-tag `latest` is 0.163.0 |

## Claude Code

Pinned base version of Osen is 2.1.288 (verified: code read, Osen c02ffe6, 2026-10-20, `cli-agents/discovery.ts:27-28`, `VERIFIED_VERSIONS`). The installed 2.1.288 package was run from a temporary npm prefix.

| Item | Value |
|---|---|
| Launch by Osen | verified: code read, Osen c02ffe6, 2026-10-20, `packages/core/src/cli-agents/discovery.ts:103-128`: explicit registry `path` first (a non-executable path is final, PATH is not searched), then the Osen process `PATH`, then the login-shell `PATH` (`$SHELL -ilc`, 5 s). The path is used as found, no `realpath`. Version probe is `--version`, 10 s (`discovery.ts:76-79`). Help is read with `claude --help` (`args.ts:8`) |
| Turn command line | verified: code read, Osen c02ffe6, 2026-10-20, `args.ts:50-53`: `--print --output-format json --tools "" --strict-mcp-config --setting-sources "" --system-prompt <text> --no-session-persistence`, plus `--disable-slash-commands`, `--model`, `--json-schema` when declared by help. The request goes through stdin (`driver.ts:110`) |
| Environment | verified: code read, Osen c02ffe6, 2026-10-20, `driver.ts:111`: the whole inherited environment (process env plus `.env` keys) plus `COUNCIL_PARTICIPANT=1`. `CLAUDE_CONFIG_DIR` and `HOME` are never set or cleared. Only `ELECTRON_RUN_AS_NODE` is removed, and only in the headless entry points (`apps/desktop/src/headless/runtime.ts:4-6`) |
| Config and login dir | verified: claude 2.1.304, 2026-10-20, `CLAUDE_CONFIG_DIR=<empty dir> claude auth status` reports `configDirectory` as that dir and creates `.claude.json`, `.claude.json.lock`, `backups/.claude.json.backup.<ts>` there. Default is `~/.claude` plus `~/.claude.json` |
| Machine output | verified: code read, Osen c02ffe6, 2026-10-20, `driver.ts:36-53`: one JSON document (or an array, last `result` event wins); `is_error` is a failure; text from `structured_output` or `result`; usage from `input_tokens`, `cache_*`, `output_tokens`, `total_cost_usd`; unknown fields ignored |
| Authentication | verified: claude 2.1.304, 2026-10-20, `claude auth status` prints JSON with `loggedIn` and `authMethod` (owner: `loggedIn` true, `claude.ai`). A login exists as macOS Keychain item named `Claude Code-credentials` (name only was listed, no secret read). Osen never signs in and has no auth probe; a logged-out CLI is detected only by the error text (`errors.ts:20-53`, verified: code read, Osen c02ffe6, 2026-10-20) |
| Isolation | verified: code read, Osen c02ffe6, 2026-10-20, `args.ts:28`, `args.ts:50-51`: no tools, no MCP servers, no settings sources, own system prompt, no session persistence, empty temp working dir (`driver.ts:98-102`); the 7 required flags are checked against `claude --help` of 2.1.288 (fixture `claude-2.1.288-help.txt`) |
| Stop | verified: code read, Osen c02ffe6, 2026-10-20, `process.ts:53-67`: SIGTERM to the whole process group, SIGKILL after 2000 ms; turn timer and owner stop abort the call (`engine.ts:263-269`) |
| Exact-version install, npm | verified: claude 2.1.288, 2026-10-20, `npm install --prefix $T/claude-npm @anthropic-ai/claude-code@2.1.288` then `$T/claude-npm/node_modules/.bin/claude --version` prints `2.1.288 (Claude Code)`. The executed file is `bin/claude.exe`, a Mach-O arm64 binary (hard link of the optional dependency `@anthropic-ai/claude-code-darwin-arm64`), 229255312 bytes, sha256 `bbe93063f7a0879a1021b2891e5c9354e5b3b98433e32efe6750f7710afed750`. No Node needed at run time (see the setup page) |
| Exact-version install, native installer | documented: https://code.claude.com/docs/en/setup, read 2026-10-20: `curl -fsSL https://claude.ai/install.sh \| bash -s <version>` installs an exact version into `~/.local/share/claude/versions/` with launcher `~/.local/bin/claude`. The page lists no install-prefix option, so it cannot be confined to a project folder. Not run |
| Self-update disable | documented: https://code.claude.com/docs/en/setup, read 2026-10-20: `DISABLE_AUTOUPDATER=1` (in the `env` key of `settings.json`, or in the process environment) stops the background check, but `claude update` still works; `DISABLE_UPDATES` blocks all update paths; `minimumVersion` and `autoUpdatesChannel` are further settings. The names are present in the 2.1.288 binary (verified: claude 2.1.288, 2026-10-20, `strings`) |
| Self-update disable, effect | not verified: with `DISABLE_AUTOUPDATER=1` and a `settings.json` `env` entry, `claude --version` of 2.1.288 left the binary sha256 unchanged (2026-10-20), but `--version` exits before any update check, so this proves nothing. A session was not started (it could reach a model). `claude doctor` was not run |
| Self-update happens | verified: claude 2.1.304, 2026-10-20, `~/.claude/.last-update-result.json` records path `npm-global`, `version_from` 2.1.302, `version_to` 2.1.304, outcome success at 2026-10-20T09:43Z: the auto-updater rewrites an npm-global install in place |
| Separate login for a separate config dir | verified: claude 2.1.288 and 2.1.304, 2026-10-20, `CLAUDE_CONFIG_DIR=<empty dir> claude auth status` gives `loggedIn` false, `authMethod` none, exit 1, while the default dir gives `loggedIn` true. A new dir does not see the owner's login, so a separate login is needed. Logging in to a new dir was not done (needs the owner) |
| Shared-dir format migration | not verified: claude 2.1.288 read a `.claude.json` written by 2.1.304 without error (`migrationVersion` 14 in both) but rewrote it (sha256 changed), 2026-10-20. Dirs were empty: no sessions, no history, no credentials were exercised. The changelog for 2.1.288 to 2.1.304 (https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md, read 2026-10-20) has no entry about a config-dir format change, but `~/.claude.json` carries a numbered `migrationVersion` that a newer build may raise |
| Release source | documented: https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md, read 2026-10-20 (newest entry 2.1.304); npm package `@anthropic-ai/claude-code` (544 versions, 2.1.288 exists, verified: npm view, 2026-10-20) |

## Codex CLI

Pinned base version of Osen is 0.159.2 (verified: code read, Osen c02ffe6, 2026-10-20, `cli-agents/discovery.ts:27-28`, `VERIFIED_VERSIONS`). The same version was installed from npm into a temporary prefix and compared with the global one.

| Item | Value |
|---|---|
| Launch by Osen | verified: code read, Osen c02ffe6, 2026-10-20, `discovery.ts:103-128`: the same search order as for Claude. Help is read with `codex exec --help` (`args.ts:8`) and `codex features list` (`registry/providers.ts:55`, parsed by `flags.ts:15-22`) |
| Turn command line | verified: code read, Osen c02ffe6, 2026-10-20, `args.ts:55-59`: `exec --sandbox read-only --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --json`, then `--disable <feature>` for 13 features (`args.ts:13`), `--model`, `--output-schema`, and `-` (request through stdin) |
| Environment | verified: code read, Osen c02ffe6, 2026-10-20, `driver.ts:111`: the whole inherited environment plus `COUNCIL_PARTICIPANT=1`. `CODEX_HOME` is not set for the child, but it is read by Osen for the model list (`models.ts:125-128`) |
| Config and login dir | verified: codex-cli 0.159.2, 2026-10-20, `CODEX_HOME=<empty dir> codex login status` creates only a `tmp/arg0/...` helper folder there (no `config.toml`, no `auth.json`). Default is `~/.codex`; the login is `~/.codex/auth.json` (4216 bytes; only key names were looked at) |
| Machine output | verified: code read, Osen c02ffe6, 2026-10-20, `driver.ts:68-91`: `--json` JSONL; bad lines skipped; last `agent_message` is the text; `turn.completed.usage` gives tokens; `error` and `*.failed` events are failures; a tool-call item is a failure (`driver.ts:56`) |
| Authentication | verified: codex-cli 0.159.2, 2026-10-20, `codex login status` prints `Logged in using ChatGPT` (exit 0) in the default dir and `Not logged in` (exit 1) in an empty `CODEX_HOME`. The key `cli_auth_credentials_store` accepts file, keyring, auto, ephemeral (documented: https://learn.chatgpt.com/docs/config-file/config-reference, read 2026-10-20) |
| Isolation | verified: code read, Osen c02ffe6, 2026-10-20, `args.ts:29`, `args.ts:55-58`: read-only sandbox, no git check, ephemeral, user config and rules ignored, 13 capabilities disabled; every one of them must be present in `codex features list` or launch is refused (`args.ts:41-44`). `codex exec --help` of 0.159.2 lists `--sandbox`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--json`, `--disable`, `-c/--config` (verified: codex-cli 0.159.2, 2026-10-20) |
| Stop | verified: code read, Osen c02ffe6, 2026-10-20, `process.ts:53-67` and `engine.ts:263-269`: same as for Claude |
| Exact-version install, npm | verified: codex-cli 0.159.2, 2026-10-20, `npm install --prefix $T/codex-npm @openai/codex@0.159.2` then `.bin/codex --version` prints `codex-cli 0.159.2`. `.bin/codex` is a Node wrapper (`bin/codex.js`); the executed native binary is `node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`, 240184096 bytes, sha256 `16593cc2f422d5f398a8e40f550ebbaf1245392528957be342c295920a300704`, byte-identical to the global standalone 0.159.2 binary |
| Exact-version install, standalone installer | documented: https://chatgpt.com/codex/install.sh (script read in full, 2026-10-20): `--release <version>` or `CODEX_RELEASE`, `CODEX_INSTALL_DIR`, `CODEX_HOME`, `CODEX_NON_INTERACTIVE`. It adds a PATH block to a shell profile under `$HOME` and works with the daemon updater pid file, so it cannot be confined to a project folder. Not run |
| Self-update disable | documented: https://learn.chatgpt.com/docs/config-file/config-reference, read 2026-10-20: `check_for_update_on_startup = false` in `config.toml` ("set to false only when updates are centrally managed"). The key is present in the 0.159.2 binary (verified: codex-cli 0.159.2, 2026-10-20, `strings`). No environment variable for it was found (verified: codex-cli 0.159.2, 2026-10-20, `strings`, absence of evidence) |
| Self-update disable, effect | not verified: sha256 of the 0.159.2 binary was unchanged after `codex --version` and `codex features list` with the key set in a `config.toml` in `CODEX_HOME` (2026-10-20), but the update check runs when the interactive UI starts, which was not run. Whether `-c check_for_update_on_startup=false` works together with `--ignore-user-config` is also not verified |
| Self-update subcommand | verified: codex-cli 0.159.2, 2026-10-20, `codex --help` lists `update`: "Update Codex to the latest version" (not run) |
| Separate login for a separate config dir | verified: codex-cli 0.159.2 and 0.163.0, 2026-10-20, `CODEX_HOME=<empty dir> codex login status` prints `Not logged in` (exit 1). A separate login is needed. Logging in to a new dir was not done (needs the owner) |
| Shared-dir format migration | not verified: codex-cli 0.159.2 ran `login status` and `features list` on a dir created by 0.163.0 without error and both versions create the same file set in an empty dir (2026-10-20). The SQLite file names in both binaries are the same (`state_5`, `logs_2`, `memories_1`, `queue_1`, `goals_1`, `thread_history_1`). Real sessions and databases were not exercised. Release notes 0.160.0 to 0.163.0 mention no config-dir migration (documented: https://api.github.com/repos/openai/codex/releases/tags/rust-v0.163.0, read 2026-10-20) |
| Release source | verified: GitHub releases API, tag `rust-v<version>`, codex-cli 0.159.2 to 0.163.0, 2026-10-20; npm package `@openai/codex` (0.159.2 and 0.163.0 exist, per-platform suffix versions also appear in the list) |

## What Osen already protects

| Protection | Where (file:line, packages/core/src unless noted) | Status |
|---|---|---|
| Claude isolation arguments | `cli-agents/args.ts:50-53` | verified: read, Osen c02ffe6, 2026-10-20; test `args.test.ts` "claude: exact set without model and schema" |
| Codex isolation arguments and 13 disabled features | `cli-agents/args.ts:13`, `args.ts:55-58` | verified: read, Osen c02ffe6, 2026-10-20; test `args.test.ts` "codex: exact set with schema" |
| Launch refused when a required flag is missing from help | `cli-agents/args.ts:27-38` | verified: test `args.property.test.ts`, Osen c02ffe6, 2026-10-20; test `providers.test.ts` "isolation flag missing" |
| Codex launch refused when the feature list is unread or incomplete | `cli-agents/args.ts:41-44`, `cli-agents/flags.ts:15` | verified: test `args.test.ts`, scenario `scenarios/codex-isolation/check.ts`, Osen c02ffe6, 2026-10-20 |
| Help and feature parsing | `cli-agents/flags.ts:2-22` | verified: test `flags.test.ts`, Osen c02ffe6, 2026-10-20 |
| Optional flags dropped when undeclared; no `--bare` | `cli-agents/args.ts:47`, `args.ts:50-51` | verified: test `args.test.ts`, Osen c02ffe6, 2026-10-20 |
| Empty working dir, cleanup, `COUNCIL_PARTICIPANT` | `cli-agents/driver.ts:98-111`, `driver.ts:128` | verified: test `driver.test.ts` "7. isolation: variable, empty cwd, cleanup on success and error", Osen c02ffe6, 2026-10-20 |
| Binary search order and explicit path | `cli-agents/discovery.ts:90-128` | verified: test `discovery.test.ts`, Osen c02ffe6, 2026-10-20 |
| Version warnings (newer, older, unknown), never a refusal | `cli-agents/discovery.ts:26-28`, `discovery.ts:131-141` | verified: test `discovery.test.ts` "version warnings", `providers.test.ts` "version newer than verified", Osen c02ffe6, 2026-10-20 |
| Version parsing in linear time | `cli-agents/discovery.ts:33-43` | verified: test `discovery.test.ts`, scenario `scenarios/security-cli-version/check.ts`, Osen c02ffe6, 2026-10-20 |
| Tolerant parsing of Claude and Codex output | `cli-agents/driver.ts:36-91` | verified: test `driver.test.ts` cases 2-5, 17, Osen c02ffe6, 2026-10-20 |
| Codex tool-call detection | `cli-agents/driver.ts:56`, `driver.ts:79`, `driver.ts:87` | verified: test `driver.test.ts` "15. tool call", Osen c02ffe6, 2026-10-20 |
| Authentication, limit and exit classification | `cli-agents/errors.ts:20-53` | verified: test `errors.test.ts`, `driver.test.ts` cases 11-13, Osen c02ffe6, 2026-10-20 |
| Process-group stop with SIGKILL escalation | `cli-agents/process.ts:53-67` | verified: test `process.test.ts`, Osen c02ffe6, 2026-10-20 |
| Turn timeout, one retry, non-retryable drop | `engine.ts:263-269`, `engine.ts:354-355` | verified: test `driver.test.ts` "16b", "16c", Osen c02ffe6, 2026-10-20 |
| Isolated model-list probe | `cli-agents/models.ts:27-30`, `models.ts:77-123` | verified: test `models.test.ts`, Osen c02ffe6, 2026-10-20 |
| `CODEX_HOME` honored for the model cache | `cli-agents/models.ts:125-128` | verified: test `models.test.ts` "real readCodexModelsCache respects CODEX_HOME", Osen c02ffe6, 2026-10-20 |
| `ELECTRON_RUN_AS_NODE` not leaked (headless entries only) | `apps/desktop/src/headless/runtime.ts:4-6` | verified: test `runtime.test.ts`, Osen c02ffe6, 2026-10-20 |
| Osen MCP tools refuse inside a participant | `packages/mcp/src/start.ts:133` | verified: test `start.test.ts`, Osen c02ffe6, 2026-10-20 |

## What is missing

Status of every item: verified: code read and grep over `packages`, `apps` and `skill`, Osen c02ffe6, 2026-10-20, unless the item says not verified.

- The CLI path, version and sha256 are not written to the session journal. The journal events carry usage, model and provider id only (`protocol/schema.ts:14-21`, `schema.ts:173-290`). The version exists only in the in-memory provider status.
- There are no recorded real turns. Fixtures in `cli-agents/fixtures/` are real `claude --help` (2.1.288), `codex exec --help`, `codex features list` (0.159.2) and two trimmed model files; turn tests use synthetic output.
- There are no separate config dirs. `CLAUDE_CONFIG_DIR` appears nowhere in the code; `CODEX_HOME` is only read for the model list (`models.ts:125-128`). Setting `CODEX_HOME` for a pinned Codex therefore also redirects model listing to `models_cache.json` inside that dir, and a new dir has no such cache until Codex writes one.
- Self-update is not disabled for either CLI. No code sets `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES`, `check_for_update_on_startup` or any `-c` override (grep over `packages`, `apps`, `skill`).
- Claude `settings.json` `env` does not reach turns. Turns run with `--setting-sources ""` (`args.ts:50`), so user settings, including an `env` entry with `DISABLE_AUTOUPDATER`, are not loaded. The variable must be put into the child process environment (`driver.ts:111`) instead. Not verified in a run.
- Codex `config.toml` does not reach turns. Turns run with `--ignore-user-config` (`args.ts:55`), so `check_for_update_on_startup = false` in `config.toml` does not apply to them. `codex exec --help` of 0.159.2 declares `-c, --config <key=value>` (verified: codex-cli 0.159.2, 2026-10-20), so a command-line override `-c check_for_update_on_startup=false` is the candidate route; whether `-c` is honored together with `--ignore-user-config` is not verified. An environment variable is not available (none found).
- The binary, its version and sha256 are not re-checked at turn launch: inspection runs once per process and the cached flags are reused (`driver.ts:104-108`). A CLI that updates itself between inspection and a turn is used unchecked.
- `VERIFIED_VERSIONS` (`discovery.ts:26-28`) is a warning range with equal minimum and maximum, not a pin. There is no `pins.json`.
- No authentication probe at inspection: a logged-out CLI still shows as available until a turn fails (`registry/providers.ts:84-91`). There is no tool-call guard for Claude (tools are off by flag only).
- The full environment of the owner, including `.env` keys, reaches the CLI (`driver.ts:111`). `ELECTRON_RUN_AS_NODE` is removed only in headless entry points, not in the desktop main process.

## How it was verified

All on 2026-10-20, macOS arm64, 0 model calls, nothing installed or updated globally, no sign-in or sign-out.

- Current state: `command -v claude codex`, `claude --version`, `codex --version`, `shasum -a 256` and `file` on the real binaries, `npm ls -g --depth=0`, `ls -la ~/.claude ~/.codex`, sha256 of `~/.codex/config.toml` and `~/.claude/settings.json`, top-level keys of `~/.claude.json` (names only). The same set was taken again at the end and was equal: binary paths, versions and sha256 as in "Current binaries"; the sha256 of the two config files and the key list are not published here.
- Login and dirs: `CLAUDE_CONFIG_DIR=$T/claude-cfg claude auth status`, `CODEX_HOME=$T/codex-cfg codex login status`, and the same on the default dirs, then `find` over the created files; Keychain item names listed with `security dump-keychain` (labels only, no `-d`, no `-w`, no secret read).
- Versions and sources: `npm view <package> versions --json`, `dist-tags`, `dist`; `npm install --prefix $T/<name> @anthropic-ai/claude-code@2.1.288`, `@openai/codex@0.159.2` and `@openai/codex@0.163.0` (the third for the migration comparison); `--version` of each; `shasum -a 256` of every executed binary.
- Documents read: https://code.claude.com/docs/en/setup, https://github.com/openai/codex (README), https://chatgpt.com/codex/install.sh, https://learn.chatgpt.com/docs/config-file/config-reference (first 100000 of 156747 characters), the Claude Code `CHANGELOG.md`, GitHub release notes of Codex 0.159.2 to 0.163.0.
- Self-update: `strings` on both pinned binaries for the setting names; `--version` with the disabling environment or config and sha256 before and after (a weak check, see the tables).
- Migration: 2.1.288 and 2.1.304 each on its own empty dir, then 2.1.288 on the dir written by 2.1.304; 0.159.2 and 0.163.0 each on its own empty dir, then 0.159.2 on the dir written by 0.163.0.
- Code: the files named in the tables were read at Osen commit c02ffe6; test names come from the test files.
- Direct evidence that self-update rewrites the npm-global install: the global `claude` moved from 2.1.302 to 2.1.304 on the same day (`~/.claude/.last-update-result.json`, path `npm-global`, success, 2026-10-20T09:43Z). This is why the global Claude Code is 2.1.304, not the pinned base 2.1.288.
- Not done: a login into a new config dir, an interactive session (update check), `claude doctor`, the native installers.

## Decision

Safe default; revisit if a shared-dir migration test proves safety. Change 176 reads this section.

### Claude Code

- Install method: npm package `@anthropic-ai/claude-code@<version>` installed with `npm install --prefix <Osen-owned prefix>`, and the executed file is the native `node_modules/@anthropic-ai/claude-code/bin/claude.exe` of that prefix. Basis: verified (claude 2.1.288, 2026-10-20) that this installs and runs the exact version without touching the global install; the native installer documents no prefix option (documented: https://code.claude.com/docs/en/setup, read 2026-10-20).
- Config dir: a separate `CLAUDE_CONFIG_DIR` for each pinned install. Cost: a one-time separate login for that dir (verified: claude 2.1.288 and 2.1.304, 2026-10-20, an empty dir reports `loggedIn` false). Basis: shared-dir safety is not verified, and 2.1.288 rewrote a `.claude.json` that 2.1.304 had written, so a shared dir can be changed by whichever version runs last.
- Self-update: set `DISABLE_AUTOUPDATER=1` in the environment of the child process that Osen starts. Do not rely on `settings.json` `env`, because turns run with `--setting-sources ""`. The effect on a running session is not verified; `claude update` stays possible unless `DISABLE_UPDATES=1` is also set, which 176 may add.

### Codex CLI

- Install method: npm package `@openai/codex@<version>` installed with `npm install --prefix <Osen-owned prefix>`, and Osen runs the vendored native binary `node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex` directly (verified: codex-cli 0.159.2, 2026-10-20, it is byte-identical to the standalone binary and avoids the Node wrapper). The standalone installer is not used: it edits a shell profile under `$HOME` and works with an updater daemon (documented: https://chatgpt.com/codex/install.sh, read 2026-10-20).
- Config dir: a separate `CODEX_HOME` for each pinned install. Cost: the same one-time separate login (verified: codex-cli 0.159.2 and 0.163.0, 2026-10-20, an empty `CODEX_HOME` prints `Not logged in`). Basis: shared-dir safety is not verified. Note for 176: Osen already reads `CODEX_HOME` for `models_cache.json` (`models.ts:125-128`), so exporting it for the pin also moves model listing to the new dir.
- Self-update: `check_for_update_on_startup = false` is the documented switch, but it lives in `config.toml` and turns run with `--ignore-user-config`, so a `config.toml` in the new `CODEX_HOME` does not apply to turns. 176 must pass the override on the command line, `-c check_for_update_on_startup=false` (`codex exec --help` of 0.159.2 declares `-c, --config <key=value>`, verified: codex-cli 0.159.2, 2026-10-20), and record in its own verification whether it is honored with `--ignore-user-config`; until proven, the effect is not verified. No environment variable for this was found.

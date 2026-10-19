# Client acceptance matrix

How the `osen` MCP server and the Osen skill connect to each agent client, and what is actually proven on the owner's machine. Changes 140 (connection module) and 142 (Connections settings) take the connection method, the restart and approval notes and the skill support from this table; nothing here is a guess.

Every value cell starts with one of three statuses:

- `verified` — checked on this machine: client version, date and the command or file that proved it;
- `documented` — taken from the client's documentation: link and reading date;
- `not verified` — neither; the reason is given.

Checks ran on 2026-10-19 with 0 model calls. Writes went only to temporary `HOME` and `CODEX_HOME` folders inside `.council-data/clients-check-*`; the real `~/.claude.json`, `~/.codex/config.toml` and `claude_desktop_config.json` were only read (server tables hashed before and after, values of foreign entries not copied).

The Codex app is installed as `/Applications/ChatGPT.app`: its bundle identifier is `com.openai.codex`, and it ships its own CLI at `Contents/Resources/codex-cli/bin/codex`. OpenAI documentation now calls it "the ChatGPT desktop app".

## Matrix

| | Claude Desktop | Claude Code | Codex CLI | Codex app (ChatGPT.app) |
|---|---|---|---|---|
| Client version | verified: Claude.app 2.37337.1 (`CFBundleShortVersionString`), 2026-10-19 | verified: 2.1.302 (`claude --version`), 2026-10-19 | verified: codex-cli 0.159.2 (`codex --version`), 2026-10-19 | verified: ChatGPT.app 26.1013.40934, bundle id `com.openai.codex`, bundled codex-cli 0.163.0-alpha.10.2, 2026-10-19 |
| Connection method | documented: edit `~/Library/Application Support/Claude/claude_desktop_config.json`, key `mcpServers.<name>`; the client has no command for it ([MCP docs, "Connect to local MCP servers"](https://modelcontextprotocol.io/docs/develop/connect-local-servers), read 2026-10-19) | verified: `claude mcp add --scope user <name> -e K=V -- <command> [args]` writes `mcpServers.<name>` into `~/.claude.json`; `--scope project` writes `.mcp.json` in the current folder; `claude mcp remove --scope <scope> <name>` deletes it (2.1.302, 2026-10-19) | verified: `codex mcp add <name> --env K=V -- <command> [args]` writes `[mcp_servers.<name>]` into `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`); `codex mcp remove <name>` deletes it and leaves an empty file (0.159.2, 2026-10-19) | verified: the bundled `codex mcp add/remove` writes the same `[mcp_servers.<name>]` table into the same `$CODEX_HOME/config.toml` (0.163.0-alpha.10.2, 2026-10-19); documented: "The ChatGPT desktop app, Codex CLI, and IDE extension share this configuration" ([Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), read 2026-10-19) |
| stdio entry format | verified: the real file has top-level keys `coworkUserFilesPath`, `mcpServers`, `preferences`; each existing server entry has keys `command` and `args` (Claude.app 2.37337.1, file read by structure only, 2026-10-19); documented: `env` object per entry ([MCP docs](https://modelcontextprotocol.io/docs/develop/connect-local-servers), read 2026-10-19) | verified: `{"type": "stdio", "command": "...", "args": [], "env": {"K": "V"}}` in both `~/.claude.json` and `.mcp.json` (under `mcpServers`) (2.1.302, 2026-10-19) | verified: `[mcp_servers.<name>]` with `command = "..."` (and `args` when given), env in a nested `[mcp_servers.<name>.env]` table (0.159.2, 2026-10-19) | verified: byte-identical table to Codex CLI from the bundled binary (0.163.0-alpha.10.2, 2026-10-19) |
| `env` support | documented: `env` object in the entry ([MCP docs, troubleshooting](https://modelcontextprotocol.io/docs/develop/connect-local-servers), read 2026-10-19); not checked that the client passes it to the process | verified: `-e K=V` stored and shown by `claude mcp get` (2.1.302, 2026-10-19); `-e` is variadic, so the server name must come before it | verified: `--env K=V` stored, `codex mcp get` and `list` mask the value as `K=*****`, `get --json` prints it (0.159.2, 2026-10-19) | verified: same as Codex CLI with the bundled binary (0.163.0-alpha.10.2, 2026-10-19) |
| Works without Node and the repository | documented: `command` is any executable; paths must be absolute ([MCP docs, troubleshooting](https://modelcontextprotocol.io/docs/develop/connect-local-servers), read 2026-10-19); launch of a non-Node binary not checked here | verified: an entry with the absolute path `/usr/bin/true` was launched by `claude mcp get`/`list` (health check reports `CONNECTION_CLOSED` because `true` exits) (2.1.302, 2026-10-19) | verified: an entry with the absolute path `/usr/bin/true` is accepted and listed as `enabled` (0.159.2, 2026-10-19); `codex mcp list` does not launch the server, so the launch itself is not checked | verified: the entry is accepted by the bundled binary (0.163.0-alpha.10.2, 2026-10-19); launch by the app not checked |
| How the client shows the server's tools | documented: input box → "Add files, connectors, and more" → Connectors → Manage connectors → server name ([MCP docs](https://modelcontextprotocol.io/docs/develop/connect-local-servers), read 2026-10-19); window check is in change 143 | verified: `claude mcp list` and `claude mcp get <name>` show scope, status, command and env (2.1.302, 2026-10-19); the in-session `/mcp` list needs a session and is not checked here | verified: `codex mcp list` and `codex mcp get <name>` show transport, command, env, status (0.159.2, 2026-10-19); documented: `/mcp` in the TUI ([Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), read 2026-10-19) | documented: type `/mcp` in the composer to see connected servers ([Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), read 2026-10-19); window check is in change 143 |
| Approval in the client | documented: each tool call asks the owner for approval ([MCP docs](https://modelcontextprotocol.io/docs/develop/connect-local-servers), read 2026-10-19); no approval of the entry itself is described | verified: `--scope user` entry is active without approval; `--scope project` entry shows `Pending approval (run claude to approve)`; `claude mcp list` also picks up `.mcp.json` files from parent folders (2.1.302, 2026-10-19) | documented: global entries need no approval; project `.codex/config.toml` is read for trusted projects only ([Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), read 2026-10-19); verified: the repository's `.codex/config.toml` adds `osen` to `codex mcp list` when run inside it (0.159.2, 2026-10-19) | documented: same configuration and trust rules as Codex CLI ([Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), read 2026-10-19) |
| Restart after writing the entry | documented: "completely quit Claude Desktop and restart it" ([MCP docs](https://modelcontextprotocol.io/docs/develop/connect-local-servers), read 2026-10-19) | not verified: whether a running session picks up a new entry was not checked (needs a session); new sessions read it, as `claude mcp list` shows | documented: changes to `~/.codex/config.toml` require a restart ([Codex skills docs](https://learn.chatgpt.com/docs/build-skills), read 2026-10-19) | documented: "Save the server, then select Restart" ([Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), read 2026-10-19) |
| Skill support and folder | not verified: no local skill folder was found for Claude Desktop; skills there were not checked | verified: `~/.claude/skills/model-council/SKILL.md` is installed and offered as a skill in a Claude Code 2.1.302 session, 2026-10-19; documented: changes under `~/.claude/skills/` are picked up without a restart ([Claude Code skills docs](https://code.claude.com/docs/en/skills), read 2026-10-19) | documented: user skills live in `$HOME/.agents/skills`, repository skills in `.agents/skills` up to the repository root; changes are detected automatically ([Codex skills docs](https://learn.chatgpt.com/docs/build-skills), read 2026-10-19); not verified: whether 0.159.2 still reads user skills from `~/.codex/skills`, where `skill/install.ts` writes (the folder exists and holds the bundled `.system` skills, which is not proof that user skills there are loaded) | documented: "Standalone skills are available in the ChatGPT desktop app, Codex CLI, and IDE extension", same folders as Codex CLI ([Codex skills docs](https://learn.chatgpt.com/docs/build-skills), read 2026-10-19) |

## Fallback: Claude Desktop extension (`.mcpb`)

| | Claude Desktop |
|---|---|
| Format | documented: an `.mcpb` file is a zip archive with a local MCP server and `manifest.json`; opening it in Claude for macOS shows an install dialog; binary servers go in `server/`, static linking preferred ([modelcontextprotocol/mcpb](https://github.com/modelcontextprotocol/mcpb), read 2026-10-19) |
| Switch criterion | not verified: checked in change 143 on the installed client. The council decided to switch to `.mcpb` if it proves noticeably more reliable than writing `claude_desktop_config.json` directly; measurably, switch if any of these holds: (a) Claude Desktop does not pick up `mcpServers.osen` after a restart; (b) its documentation declares direct config editing unsupported or changes the file path or format; (c) it does not pass `env` from the entry to the stdio server |

## Notes for changes 140 and 142

- The Codex app and Codex CLI share one `~/.codex/config.toml`: one `[mcp_servers.osen]` entry serves both, so the app is not a separate write target.
- The Codex skill folder in the documentation (`~/.agents/skills`) differs from the one `skill/install.ts` uses (`~/.codex/skills`). Until a Codex session confirms which folder 0.159.2 reads, the Codex skill cell stays `documented`.
- Claude Desktop needs a full quit and restart after the entry is written; the Codex app needs Restart; a Claude Code project-scope entry needs approval in the client.

## How verified

Run on 2026-10-19, macOS, `T=.council-data/clients-check-<pid>`:

```sh
claude --version
codex --version
defaults read /Applications/Claude.app/Contents/Info CFBundleShortVersionString
defaults read /Applications/ChatGPT.app/Contents/Info CFBundleIdentifier
/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --version

HOME=$T/home claude mcp add --scope user osen-matrix-check -e K=V -- /usr/bin/true
HOME=$T/home claude mcp get osen-matrix-check
HOME=$T/home claude mcp list
HOME=$T/home claude mcp remove --scope user osen-matrix-check
cd $T/proj && HOME=$T/home claude mcp add --scope project osen-matrix-check -e K=V -- /usr/bin/true
HOME=$T/home claude mcp get osen-matrix-check
HOME=$T/home claude mcp remove --scope project osen-matrix-check

CODEX_HOME=$T/codex codex mcp add osen-matrix-check --env K=V -- /usr/bin/true
CODEX_HOME=$T/codex codex mcp get osen-matrix-check --json
CODEX_HOME=$T/codex codex mcp list
CODEX_HOME=$T/codex codex mcp remove osen-matrix-check
CODEX_HOME=$T/codex-app /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex mcp add osen-matrix-check --env K=V -- /usr/bin/true

jq -S '{top: keys, servers: (.mcpServers | keys), shape: (.mcpServers | map_values(keys))}' \
  "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
```

Untouched real configs: `jq -S .mcpServers ~/.claude.json`, the `[mcp_servers.*]` tables of `~/.codex/config.toml` and `jq -S .mcpServers` of `claude_desktop_config.json` were hashed before and after the checks and matched.

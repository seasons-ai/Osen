# Osen

Several models take turns analyzing a problem, editing a shared solution, arguing and asking each other questions until they agree. Launch it from the desktop app with the autumn-style interface, or from Claude Code and Codex through the MCP server and the skill.

- Architecture and protocol: [docs/architecture.md](docs/architecture.md)
- Discussion templates: [docs/templates.md](docs/templates.md)
- Work queue: `openspec list`
- Rules for agents: [AGENTS.md](AGENTS.md)

## Install and check

Node 22.18 or newer is required. There is no build step: Node runs the TypeScript itself. Commands in this README and in `docs/` run from the repository root.

```bash
git clone https://github.com/seasons-ai/Osen.git
cd Osen
npm install
npm run typecheck
npm test
```

## Desktop app

```bash
COUNCIL_HOME=.council-data npm run desktop
```

Without `COUNCIL_HOME` the app works with the owner's data folder. macOS installer image: `npm run dist`; check the contents: `npm run dist:check`; install, update and rollback: [docs/deploy.md](docs/deploy.md).
Screens, notifications, usage and tariff estimates: [docs/desktop.md](docs/desktop.md).

## The `council` command

Runs a discussion from the terminal: `npx council --help`. Subcommands, the owner's messages and questions, waiting for the owner, resuming, lineups, the token ceiling and independent drafts: [docs/cli.md](docs/cli.md).

## Materials

Files, folders, PDFs and links that go into every turn: [docs/materials.md](docs/materials.md).

## Participants

CLI participants (`claude`, `codex`), HTTP participants and the free fake server: [docs/participants.md](docs/participants.md).

## MCP server

The `osen` server lets an agent (Claude Code, Codex) start a discussion, follow it and stop it, pass the owner's messages and answers into it, and release the owner wait, without leaving the chat. The transport is stdio, the entry point is `packages/mcp/src/main.ts`.

Tools, behavior and the free check: [docs/mcp.md](docs/mcp.md).

### Connecting in this project

1. The entry is already in `.mcp.json` at the repository root.
2. Start Claude Code in the project root:

```bash
claude
```

3. On first launch Claude Code asks about the project server `osen` — confirm.
4. Run `/mcp`: the list should show `osen` and seven tools.

The same entry by hand (it writes only to the project's `.mcp.json`; specify exactly `--scope project`, since by default the `local` scope writes to the user's personal settings):

```bash
claude mcp add --scope project osen -- node packages/mcp/src/main.ts
```

The agents' global settings are not changed.

Codex does not read `.mcp.json`. Without an entry in `~/.codex/config.toml`, the server is connected for a single run with `-c` flags (a permanent connection for both agents is made by the installation from the section [docs/mcp.md, "Skill for agents"](docs/mcp.md#skill-for-agents)):

```bash
codex -c 'mcp_servers.osen.command="node"' -c "mcp_servers.osen.args=[\"$PWD/packages/mcp/src/main.ts\"]"
```

## Skill for agents

The `osen` skill and server are installed into Claude Code and Codex only with the owner's consent; preview with `node skill/install.ts --dry-run`. Details: [docs/mcp.md](docs/mcp.md#skill-for-agents).

## Interface language

English and Русский, English by default: [docs/data.md](docs/data.md#interface-language).

## Versions and releases

Versions, commit format and the two-stage release: [docs/releases.md](docs/releases.md).

## Data

Data folder, migration from `model-council` and file formats: [docs/data.md](docs/data.md#data).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="design/mockup-osen/brand/svg/osen-logo.svg">
  <img alt="Osen" src="design/mockup-osen/brand/svg/osen-logo-light.svg" width="249">
</picture>

[![version](https://img.shields.io/github/package-json/v/seasons-ai/Osen?filename=apps%2Fdesktop%2Fpackage.json&style=flat&color=e8925a)](CHANGELOG.md)
[![ci](https://img.shields.io/github/actions/workflow/status/seasons-ai/Osen/ci.yml?style=flat&branch=main)](https://github.com/seasons-ai/Osen/actions/workflows/ci.yml)
[![platform](https://img.shields.io/badge/platform-macOS%20arm64-lightgrey?style=flat)](docs/deploy.md)

Several models take turns on your problem, editing one shared solution, until they agree.

**Status:** early. Built for one owner on macOS; every mechanism is tested on scripted participants with zero model calls.

## Who this is for

Osen is for the moment you ask two or three models the same hard question and then spend an hour reconciling their answers by hand. Instead, the models argue over one shared version: each turn amends it, agrees with it or objects, and the discussion ends when every participant accepts the same version — or says plainly that they did not.

You stay in the loop: send a message into a running discussion, answer the questions the models ask you, pause after each round, or pick a version yourself. Run it from the desktop app, from the terminal, or from Claude Code and Codex without leaving the chat.

## The idea

The engine runs the discussion, not the models. Turn order, the count of who agreed and the end of the session are decided by code: consensus means every active participant accepted the current version and no question is left open. A model cannot declare consensus in prose.

A session is a journal of typed events, and its state is only ever a fold of that journal. A killed process loses nothing that was written; an interrupted session is resumed from the same journal. Participants run without tools, MCP servers or your instructions, in an empty temporary folder: your files reach them only as text in the request.

The same discussion from the terminal, on scripted participants (0 model calls):

````console
$ COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "Should the README lead with the product or with the install steps?" --participant scripted:packages/core/scenarios/readme/p1.json --participant scripted:packages/core/scenarios/readme/p2.json --max-rounds 3
Session feba7dcc-553e-4a54-a018-26fe0118c7e4 · participants: 2 · round limit: 3
Topic: Should the README lead with the product or with the install steps?
{
  "stance": "amend",
  "reasoning": "A reader decides in the first screen. Say what the product is and show one real run; install comes next.",
  "solution": "Open the README with one line about the product and a real run, then the install steps.",
  "answers": [],
  "questions": []
}

── Turn 1 · round 1 · p1 «Participant 1» · amend → version 1
Arguments: A reader decides in the first screen. Say what the product is and show one real run; install comes next.
Usage: participants do not report tokens, accounting incomplete
{
  "stance": "amend",
  "reasoning": "Agreed on the order, but the reference still makes the page a wall of text. Move it to docs/ and link it.",
  "solution": "Open the README with one line about the product and a real run, then the install steps. Keep the reference in docs/ and link each part from a short section.",
  "answers": [],
  "questions": []
}

── Turn 2 · round 1 · p2 «Participant 2» · amend → version 2
Arguments: Agreed on the order, but the reference still makes the page a wall of text. Move it to docs/ and link it.
Usage: participants do not report tokens, accounting incomplete
{
  "stance": "agree",
  "reasoning": "Moving the reference out keeps the first screen short. I agree.",
  "solution": null,
  "answers": [],
  "questions": []
}

── Turn 3 · round 2 · p1 «Participant 1» · agree
Arguments: Moving the reference out keeps the first screen short. I agree.
Usage: participants do not report tokens, accounting incomplete

══ Outcome: consensus
Version 2, author p2
Agreed: p1, p2

Decision:
Open the README with one line about the product and a real run, then the install steps. Keep the reference in docs/ and link each part from a short section.
````

The same session in the app, on the "Discussion" screen:

![The Discussion screen: participants, the turn feed by rounds and the current version of the solution](docs/images/osen-discussion.png)

## Install

Node 22.18 or newer. There is no build step for development: Node runs the TypeScript itself. Every command here and in `docs/` runs from the repository root.

```bash
git clone https://github.com/seasons-ai/Osen.git
cd Osen
npm install
```

Check the tree:

```bash
npm run typecheck
npm test
```

The macOS installer image (`.dmg`, Apple Silicon):

```bash
npm run dist
```

Check its contents with `npm run dist:check`. Install, first launch, update and rollback: [docs/deploy.md](docs/deploy.md).

## Three ways to run

### The app

```bash
COUNCIL_HOME=.council-data npm run desktop
```

The window opens on "History". Without `COUNCIL_HOME` the app works with your own data folder. Screens, notifications, usage and tariff estimates: [docs/desktop.md](docs/desktop.md).

### The `council` command

The example above is the whole shape: a topic, two or more participants, a round limit. With real participants:

```bash
COUNCIL_HOME=.council-data npx council --topic "Rewrite the reports module or fix it piece by piece" --participant claude:haiku --participant codex --max-rounds 2
```

This calls real models and spends your subscription. `npx council --help` lists every flag; subcommands, resuming, lineups and the token ceiling: [docs/cli.md](docs/cli.md).

### The MCP server and the skill

The `osen` server lets Claude Code or Codex start a discussion, follow it, pass your messages and answers into it and stop it, without leaving the chat. The transport is stdio, the entry point `packages/mcp/src/main.ts`.

#### Connecting in this project

1. The entry is already in `.mcp.json` at the repository root.
2. Start Claude Code in the project root:

```bash
claude
```

3. On first launch Claude Code asks about the project server `osen` — confirm.
4. Run `/mcp` (or `claude mcp list` in the terminal): the list shows `osen`, and `/mcp` shows its seven tools.

The same entry by hand. It writes only to the project's `.mcp.json`; say `--scope project` explicitly, since the default `local` scope writes to your personal settings:

```bash
claude mcp add --scope project osen -- node packages/mcp/src/main.ts
```

Codex does not read `.mcp.json`. For a single run, connect the server with `-c` flags:

```bash
codex -c 'mcp_servers.osen.command="node"' -c "mcp_servers.osen.args=[\"$PWD/packages/mcp/src/main.ts\"]"
```

A permanent connection for both agents, together with the `osen` skill, writes to their global settings — preview it first with `node skill/install.ts --dry-run`. Tools, behaviour and the installer: [docs/mcp.md](docs/mcp.md).

## Features

| Feature | What it does | Details |
|---|---|---|
| Participants | `claude` and `codex` CLIs, any OpenAI-compatible HTTP endpoint, a free fake server for checks | [docs/participants.md](docs/participants.md) |
| Templates | Roles and rules for a kind of discussion; `npx council templates` lists them | [docs/cli.md](docs/cli.md#the-council-command) |
| Materials | Files, folders, PDFs and links in every turn; large folders are read on request, `.gitignore` rules apply | [docs/materials.md](docs/materials.md) |
| Owner's message | Add a remark to a running discussion; it applies after the current turn, and everyone must agree again | [docs/cli.md](docs/cli.md#owners-message) |
| Questions to the owner | Participants ask you; your answer reaches them by question id | [docs/cli.md](docs/cli.md#questions-to-the-owner) |
| Waiting for the owner | Pause after each round or on a question, with a finite deadline | [docs/cli.md](docs/cli.md#waiting-for-the-owner) |
| Resuming | Continue an interrupted, stopped or unagreed session, replacing a participant if needed | [docs/cli.md](docs/cli.md#resuming-a-session) |
| Lineups | Saved named sets of participants, separate from templates | [docs/cli.md](docs/cli.md#lineups) |
| Token ceiling | The session stops once its total tokens reach your limit; the check runs between turns, so one turn can overshoot | [docs/cli.md](docs/cli.md#token-ceiling) |
| Independent drafts | Experiment: each participant drafts alone before the discussion | [docs/cli.md](docs/cli.md#independent-drafts-experiment) |
| Owner's choice | Accept an existing version yourself, next to the models' own outcome | [docs/desktop.md](docs/desktop.md) |
| Usage and tariffs | Reported usage by period and provider, and a separate tariff estimate | [docs/desktop.md](docs/desktop.md#usage-in-history) |
| Notifications | macOS notifications when a session finishes, asks you or waits for you | [docs/desktop.md](docs/desktop.md) |
| Export | A session to Markdown, with versions, objections and drafts | [docs/desktop.md](docs/desktop.md) |
| Interface language | English and Русский, English by default | [docs/data.md](docs/data.md#interface-language) |

## Guarantees and limits

What holds:

- Participants have no tools, no MCP servers, no hooks, no skills and no access to your disk; folder files reach them only as text, through the engine.
- Keys live only in the data folder's `.env`; the config names the variable, and keys never reach the journal, logs or MCP responses.
- Through MCP an agent must name the topic, participants, round limit and call bound before a start, and wait for your consent when a participant spends a subscription or money.
- Sessions are never deleted or overwritten.

What is not there:

- macOS on Apple Silicon (arm64) only. No web version, no other systems, no auto-update.
- The image is not signed or notarized by Apple: a copy from another Mac needs "Open Anyway" on first launch ([docs/deploy.md](docs/deploy.md#first-launch-of-an-unsigned-app)).
- No ready-made image to download yet: build it with `npm run dist`.
- No money ceiling before a start, only a token ceiling: providers do not always report usage, so a total in dollars would be a guess.
- No memory between sessions.

## Roadmap

**Now — a public repository.** This README, a contributing guide and a security policy, a licence (waiting for the owner's choice), and links that still point at files the public tree does not have.

**Next — acceptance on the real thing.** Most mechanisms are proven on scripted participants and the development window. What waits is the same paths on the installed app, real `claude`, `codex` and HTTP participants, real agent dialogs over MCP and the skill, and macOS system dialogs and notifications.

**Later** — candidates without a commitment: full-text search over decisions, comparing any two versions, exporting only the final decision.

## Data

The data folder, the move from `model-council`, and every file format: [docs/data.md](docs/data.md#data).

## Versions and releases

One version for the product, Conventional Commits, and a two-stage release: [docs/releases.md](docs/releases.md).

## Contributing

An issue first, then a pull request — [CONTRIBUTING.md](CONTRIBUTING.md) has the rules and why. Vulnerabilities go to [SECURITY.md](SECURITY.md), not a public issue.

# MCP server and skill

## MCP server

The `osen` server lets an agent (Claude Code, Codex) start a discussion, follow it and stop it, pass the owner's messages and answers into it, and release the owner wait, without leaving the chat. The transport is stdio, the entry point is `packages/mcp/src/main.ts`.

From the repository no build is needed: `npm install` is enough (Node 22.18+ runs TypeScript itself).

The server provides instructions, tool descriptions and response texts in the interface language: `COUNCIL_LANG`, then `preferences.json` in the data folder, then English. The language is read once at startup, so after changing the language in the app the agent needs a server restart (a new agent session). Tool and field names, error codes and status values do not depend on the language; the agent replies to the owner in the owner's language. A check without cost is `packages/mcp/scenarios/language/check.ts`.

Connecting in this project: [README](../README.md#connecting-in-this-project).

### From the installed app

From the first release after 0.10.0 the installed app carries its own server and needs neither Node nor the repository (0.10.0 and earlier have no wrappers: use the repository and the installer below): the server command is the wrapper `/Applications/Osen.app/Contents/Resources/bin/osen-mcp` with no arguments. It starts the app binary as Node, finds the app relative to itself (a copy of `Osen.app` in another folder works the same way) and needs no `PATH`. Like every wrapper, it works only after the app has been opened once and allowed by Gatekeeper ([docs/deploy.md, "Command-line entry points"](deploy.md#command-line-entry-points)).

1. Open "Settings" → "Connections". Each client found on this Mac (Claude Desktop, Claude Code, Codex; the Codex app shares the Codex entry) shows its state, the settings file and the "Server command".
2. Press "Connect" and confirm in the dialog. Osen writes only its own `osen` entry with the wrapper path; other servers and keys stay as they were, and a foreign `osen` entry is never overwritten.
3. Press "Check connection": it starts the recorded command with a temporary data folder and expects seven tools and nothing but protocol frames on stdout. No model is called.
4. Restart the client as the tab says: quit Claude Desktop completely and start it again; restart Codex; Claude Code reads the entry in a new session.
5. "Disconnect" removes only Osen's own entry.

The same tab installs the `council` command (["The `council` command in the terminal"](deploy.md#the-council-command-in-the-terminal)). Without the app, from the repository, use the installer below.

Checked on the built image on 2026-10-19 with a substituted `HOME` and the real `claude` 2.1.302 and `codex` 0.159.2, 0 model calls (change 143): connect, state, connection check and disconnect for all three clients; a foreign `osen` entry and a foreign `council` file were refused and left byte-for-byte unchanged. A real discussion through each client has not been run yet: [docs/clients.md](clients.md).

### Tools

| Tool | Purpose |
|---|---|
| `council_options` | Templates, providers with availability and models, defaults (including the materials limit and the token ceiling `maxTotalTokens`, `null` — no ceiling), `lineups` (`id`, `name`, the `available` flag and positions: `providerId`, `model`, `role`, `available`, `reason`, `modelNote`) and `lineupsError` (the reason if the lineups file is corrupted, otherwise `null`). Starts nothing and writes nothing |
| `council_start` | `topic`, optional `templateId`, `participants` (`[{ providerId, model? }]`, at least two) or `lineupId` (a lineup identifier from `council_options`; together with `participants` it is a tool error, even if the lists are equal; with neither — default participants), `maxRounds` (1–20), `attachments` (absolute paths to files and folders), `maxTotalTokens` (the session's total token ceiling, an integer of at least 1), `pauseAfterRound`, `waitForOwner`, `ownerWaitSec` (explicitly enabling the owner wait per the engine contract; without them the session does not wait; `ownerWaitSec` is an integer from 1 to 86400, 300 by default, and is set only together with one of the modes; an invalid duration is rejected before the session is created). It immediately returns `sessionId`, the upper bound on the number of calls `maxCalls` (participants × rounds × 3), `materials` — the number of materials, their size in characters, skipped paths with reasons and `left` (how many folder files did not fit into the initial set, and the first 20 with reasons) — `folder` (the number of files and the size of the folder snapshot, or `null` if no folder is attached), the effective `maxTotalTokens` ceiling (`null` — no ceiling), `ownerWait` (the enabled modes and the duration, or `null`) and `lineup` (`id`, `name`, `notes` — notes about models that are not in the current list; `null` without a lineup); the session runs in the background; `drafts` (`false` by default) and `synthesizerId` (only with `drafts: true`) enable the "independent drafts" experiment: in the response `maxCalls` = participants × (rounds + 1) × 3 and the `drafts` field (`{ synthesizerId, synthesizerName, byDefault }` or `null`) |
| `council_status` | `sessionId`, optional `waitSec` (returns earlier on a new completed turn, an applied message or an owner's answer, a change of questions or of the wait, or the end of the session). Status, round, agreeing participants, the participants (a dropped one with `dropReason`, e.g. a pinned CLI that failed the launch check), the current version of the solution, the names and total size of the materials (without texts), `folder` (the number of files and the snapshot size, or `null`), `filesRead` (snapshot files read by participants in completed turns, without texts: `turn`, `participantId`, `name`, `chars`, `shown`; an empty list for a session without a folder), the effective `maxTotalTokens` ceiling and the total tokens `tokens` (with an incomplete-accounting flag); after completion — the outcome, the stop reason `reason` (`token_cap` — the token ceiling was reached), objectors with arguments, statistics; if the owner accepted a version in the app — `ownerSelection` (`version`, `text`, `note`, `selectedAt`, `statusAtSelection`): this is the owner's choice, not the models' agreement, and `status` and `solution` stay as they were; without a choice the field is absent; `ownerQuestions` — open questions to the owner (identifier, author, text, turn number); `waiting` — the current wait (`waitId`, reasons, held questions, deadline) or `null`, and for an interrupted session the saved wait is returned separately from the status; `ownerMessages` — applied owner messages without texts (`requestId`, turn number, answered questions); `drafts` — `null` or `{ phase: "drafting" | "finished", synthesizerId, accepted, total, items[] }` with the texts of accepted drafts from verified snapshots (a corrupted snapshot — `text: null` and `error`); this is neither a solution nor an agreement, and a new draft wakes the `waitSec` wait |
| `council_stop` | `sessionId`. Stops the session, including one started from the app or with the `council` command |
| `council_say` | `sessionId`, `text`, optional `questionId` (the identifier of an open question from `ownerQuestions`). The owner's message or answer to a question, into a running session. Returns the `requestId` of the request accepted into the queue, not a confirmation that it was applied |
| `council_continue` | `sessionId`, `waitId` (from `waiting` in `council_status`). Releases the current owner wait. Returns the `requestId` of the request accepted into the queue, not a confirmation of the release |
| `council_resume` | `sessionId`, optional `rounds` (how many more rounds, an integer from 1 to 20; if omitted — the remainder of the previous limit), `maxTotalTokens` (a new token ceiling; `null` removes the ceiling), `replacements` (`[{ participantId, providerId, model }]`: replacements for dropped or unavailable participants), `message` (the owner's reply for the resume in the owner's own words, passed only at the owner's request; required and non-blank for a `consensus` session; part of `planToken`), `execute` (`false` by default), `planToken`. Resumes a saved session. Without `execute` — a plan: the roster of active participants with the spend flag (`billing`: `subscription`, `paid`, `free`; with replacements — the future roster), `replacements` (old → new, reason), `agreementReset` (true when agreements are reset: with replacements or with `message`), `requiresConsent`, the number of rounds, the upper bound on calls `maxCalls` (active × rounds × 3), the effective ceiling and the tokens already spent, the saved owner wait (`waiting`) and `planToken`; the plan writes nothing and calls no models. With `execute: true` and `planToken` — a background continuation of the same journal with the same `sessionId`; the `accepted` response comes right after the resume event is written, and the turn and the outcome are read in `council_status`; in the plan, `draftCalls` is the remainder of calls of unfinished drafts, it is included in `maxCalls` and thereby in `planToken`; a corrupted draft snapshot is a `draft` refusal |

### Behavior

- `council_start` returns after the first journal event of the session (at most 15 seconds; a failure of the executor before the first event or no response in 15 seconds is a tool error with the reason, and no session is created); the agent reads the progress of the discussion through `council_status` with `waitSec` (waiting for a change, at most 50 seconds; a larger value is truncated, and this is visible in the response).
- A `council_start` session runs in a separate detached `council` process (the internal command `council run-prepared`, not for the owner). Closing the agent or the server (stdin close, SIGTERM, SIGINT, SIGHUP) does not interrupt it: it runs to its own end (round limit, token ceiling, owner wait), its state is readable from `council status`, the app and other MCP clients, and it is stopped with `council_stop`, `council stop <id>` or the app. Only if the executor process itself is killed or the machine restarts does the session become `interrupted` (resume it with `council_resume`). The server hands the prepared session over in `launch/<id>.<launchId>.json` of the data folder (mode 0600, no secrets, deleted by the executor once read, 15-second deadline); `launch/<id>.<launchId>.err` holds the executor's stderr until the first event and is deleted by the server. `launchId` is random and new for every launch, so two launches of the same session never read, overwrite or delete each other's files. The executor checks the 15-second deadline again right before it creates the session (after the provider checks) and, for a resume, as the last step under the lock after the replacement re-check, so after a timeout answer no session is created and no resume is written. The server answers with the timeout only after the deadline plus one poll step (100 ms), with a last readiness check. When the server quits during the wait it removes this launch's files in `launch/` (an executor that already read its file keeps running detached); at start the server removes launch, `.err` and `.accepted.json` files and their temp copies older than 60 seconds.
- `council_resume` with `execute=true` hands the resumed session to the same kind of detached `council run-prepared` process (launch file `launch/<id>.<launchId>.json` of kind `resume`, mode 0600, no secrets; the executor re-plans, rejects `stale_plan` if the journal bytes differ from the plan, takes the resume lock and writes `launch/<id>.<launchId>.accepted.json`, named after its launch file, with `droppedOwnerRequests` on acceptance; the server reads and deletes only its own launch's file, and `launch/` is empty afterwards). Of two simultaneous `council_resume` calls of one session, one is accepted and the other gets `busy`, `running` or `stale_plan`, never an executor start failure. Closing the agent or the server does not interrupt a resumed session or its owner wait; it is stopped like a `council_start` session (`council_stop`, `council stop <id>`, the app).
- A discussion participant cannot convene a discussion itself: with `COUNCIL_PARTICIPANT=1` in the server environment, `council_start`, `council_say`, `council_continue` and `council_resume` are rejected (the engine sets this variable for CLI participants).
- The owner wait is enabled only explicitly by `council_start` fields; it is finite — after the duration the discussion continues by itself. While the session waits, `council_status` returns `waiting` and `ownerQuestions`, and `statusText` is "running, waiting for the owner".
- `council_say` and `council_continue` also work with sessions started from the app or with the `council` command. Both only put a request into the live executor's queue — the application is read in `council_status` (`ownerMessages`, `waiting`). `council_continue` does not start a new session and does not add rounds, but the previous executor will keep calling models within the limits already agreed.
- `council_resume` resumes sessions with the status `interrupted`, `no_consensus`, `stopped` and `failed` with `reasonCode` `insufficient_active_participants` (visible in `council_status`; replacements are needed that leave at least two active participants, otherwise `too_few_active`); a `consensus` session is resumed only with a non-blank `message` (without it, or with whitespace only, the plan and execute are refused with code `consensus` and nothing is written); any other `failed` and a running session are refused. The `message` text is part of `planToken` (execute with a different text gives `stale_plan`: a new plan and the owner's consent are needed); on acceptance the engine writes it as `owner_message` right after `session_resumed` (`afterTurn` is the last turn before the resume), `council_status` shows it in `ownerMessages` (identifier and `afterTurn`, not the text), and the server log does not contain the text. The roster, roles, order and models are taken from the journal, and default participants are not substituted; the roster changes only through `replacements` named by the owner (the agent chooses neither provider nor model; values come from `council_options`). Replacing an available active participant, a duplicate, an unknown or already replaced `participantId`, or an unavailable new participant is a `replacement` refusal before anything is written; the former participant stays in the history (`council_status`: `replacedBy` on it, `replaces` on the new one), and agreements are reset. An unavailable participant without a replacement produces a refusal with its identifier and reason already at the plan. The `stale_plan` error means the journal, replacements, participant availability or parameters changed after the plan: a new plan and the owner's new consent are needed. Only one executor resumes a session at a time, and a second launch gets `busy` or `running`. Unapplied owner messages dropped on acceptance are returned in `droppedOwnerRequests` and are not written to the server log; if the executor itself is killed during a resumed turn or wait, the session stays `interrupted` with the saved turns and the wait deadline.
- The server cannot verify that the owner agreed to the resume: this rule is written in the server's instructions and the tool description (first the plan, a message to the owner with the topic, participants, rounds and the exact call bound, consent when `requiresConsent`, then `execute`). `planToken` only confirms that exactly the plan shown is run, and is not stored anywhere.
- A run with real participants spends subscriptions or money. Spend can be limited with a token ceiling (`maxTotalTokens` in `council_start`; by default `defaults.maxTotalTokens` from `config.json`, if set): the session stops by itself with the status `stopped` and the reason `token_cap` when the sum of tokens across turns reaches the ceiling; the check runs between turns, so the overshoot is at most one turn.
- The owner's materials are passed in `attachments` of `council_start` only as absolute paths: the server's working folder is not the project, and a relative path is rejected. Accepted formats: text (UTF-8, UTF-16, Windows-1251), PDF including scans, DOCX/DOCM, XLSX/XLSM, PPTX/PPTM, ODT/ODS/ODP, EPUB, RTF, DOC, pictures through text recognition, ZIP as a folder; a file of another format is refused when named explicitly and skipped inside a folder, with a reason naming its kind (see [docs/materials.md, "Formats and reasons"](materials.md#formats-and-reasons)). The collection rules and the limit are the same as for `council --attach` (`defaults.materialsChars` from `config.json`, 60000 characters by default; `council_options` returns it in `defaults`), with no differences: a folder larger than the limit is accepted, its files are kept in the snapshot, descriptions go into the initial set, and participants read the rest on request. A collection refusal (path not found, an explicitly named environment file or file of an unsupported format, explicitly named files larger than the limit, or a folder larger than the snapshot bound of 20000000 characters; `.env` and anything unreadable inside a folder are skipped) is returned as an error with all the reasons, and no session is created. Materials go into every call of every participant; the `maxCalls` formula does not depend on them. Material texts and source paths are not written to `logs/app.log` — only the count and size.
- The server itself passes the agent the rules of work (MCP protocol instructions): tell the owner the topic, participants, round limit and the upper bound on calls before starting, wait for consent to the spend, do not write on every turn, take the outcome only from the `council_status` response; attach only the files the owner named, by absolute paths, and tell the number and size of the materials, and for a folder larger than the limit — the snapshot size and the number of files that did not fit; pass messages, answers to questions to the owner and the release of a wait only at the owner's request and do not answer for them. They apply without the skill too.
- Lineups (see [docs/cli.md, "Lineups"](cli.md#lineups) in the section "The `council` command") are read from `lineups.json`; an unknown or unavailable lineup is a `council_start` error before the session is created. A lineup cannot be saved through MCP, only with the `council lineups save` command. Rule 10 of the server instructions: the agent takes lineups from `council_options`, names the lineup's participants (provider, model, role) to the owner before starting and waits for consent on the same terms, does not start an unavailable lineup and does not substitute participants, and passes notes about models to the owner.
- Drafts (`drafts`, `synthesizerId` in `council_start`) are an experiment: the rule in the server instructions says to enable them only at the owner's request and to name the synthesizer and the call bound `participants × (rounds + 1) × 3` to the owner before starting. Description: "Independent drafts (experiment)".
- The session lands in the same data folder (see "Data") and is visible in the app's History with the source "MCP".
- A journal that was not read in full: `council_status` returns the `journal` field — `null` or `{ reason: "newer_version" | "corrupted", lastEvent }`. With `newer_version` the journal was written by a newer version of the app: `statusText` for a session without a recorded outcome says "state undetermined", the outcome and solution are taken from the part that was read, the agent must not call such a session interrupted, and the owner needs to update the app. The errors of `council_resume`, `council_say` and `council_continue` for such a session begin with the code `newer_version`, and the journal is not changed; `council_stop` is not rejected because of the journal.
- Diagnostics are written to `logs/app.log` in the data folder (component `mcp`); only protocol messages go to standard output.

### Check without cost

Scripted participants are available to the server only with `COUNCIL_DEV=1`. Manual launch (the server waits for protocol messages on standard input; any MCP client is needed to make calls):

```bash
COUNCIL_DEV=1 COUNCIL_HOME=.council-data node packages/mcp/src/main.ts
```

`council_start` arguments with two scripted participants:

```json
{
  "topic": "Как назвать кота",
  "participants": [
    { "providerId": "scripted", "model": "consensus/p1.json" },
    { "providerId": "scripted", "model": "consensus/p2.json" }
  ],
  "maxRounds": 3
}
```

A live stand for control on behalf of the owner (0 model calls): a server over stdio and a separate `council` process with scripted participants; the agents' global settings are not changed.

```bash
COUNCIL_DEV=1 COUNCIL_HOME="$PWD/.council-data/acceptance-36-$(date +%Y%m%d-%H%M%S)" node packages/mcp/scenarios/owner-control/check.ts
```

A live stand for resuming (0 model calls): a server over stdio, the executor of the original session is a separate `council` process, participants are scripted.

```bash
COUNCIL_DEV=1 COUNCIL_HOME="$PWD/.council-data/acceptance-37-$(date +%Y%m%d-%H%M%S)" node packages/mcp/scenarios/resume/check.ts
```

A stand for participant replacement on resume (0 model calls; real `council` and a server over stdio, scripted participants; it creates the data folder itself inside `.council-data/`):

```bash
COUNCIL_DEV=1 node packages/core/scenarios/replacement/check.ts
```

A live stand for the folder snapshot through MCP (0 model calls): a server over stdio, scripted participants; the stand creates a unique data folder inside `.council-data` itself.

```bash
COUNCIL_DEV=1 node packages/mcp/scenarios/folder/check.ts
```

A live stand for named lineups (0 model calls): real `council` processes and the MCP server over stdio, scripted participants and a fake HTTP server; the result is a `PASS` line.

```bash
COUNCIL_DEV=1 COUNCIL_HOME="$PWD/.council-data/acceptance-44-$(date +%Y%m%d-%H%M%S)" node packages/mcp/scenarios/lineups/check.ts
```

### Pinned contract

Claude Code and Codex update often and may change how they call MCP servers, so the contract of `osen` is pinned on the Osen side (change 179):

- Protocol version: `EXPECTED_PROTOCOL_VERSION` in `packages/mcp/src/contract.ts` (`2025-11-25`), a literal and not the SDK constant. The server must answer `initialize` with it both for a client sending this version and for a client sending an unknown one (then the server answers with its own latest version).
- SDK: `@modelcontextprotocol/sdk` in `packages/mcp/package.json` is an exact version equal to `package-lock.json`; a range fails the contract test.
- Tool list, descriptions, schemas and instructions: `packages/mcp/src/__golden__/ru-server.json`.
- Response shapes: `packages/mcp/src/__golden__/responses/<snapshot>.json`, one per tool (`council_status` twice: a running session at the owner wait and a finished one), taken on scripted participants in Russian. Keys, nesting, value types, `isError` and all text (hints, status texts, names) are compared strictly. Unstable values are replaced by markers: by key name, and only when the value has the expected type (`pid` and `*Ms` numbers become `<pid>` and `<duration>`; `sessionId`, token and time keys with a string become `<sessionId>`, `<token>`, `<time>`); a value of another type stays as is, so the type change shows up in the diff. Inside any string a session id, an ISO timestamp and an absolute path (spaces allowed only in directory names, so the text after a path is still compared) are replaced by `<sessionId>`, `<time>`, `<path>`, and the rest of the text is compared; there is no `<text>` marker. In `council_options` every list keeps only its first element with its values reduced to types (`<string>`, `<number>`, `<boolean>`), because templates, providers and scenario files are data. The rules are listed at the top of `contract.ts`.

The tests are `packages/mcp/src/contract.test.ts` (part of `npm test`).

After updating Claude Code or Codex, run the stand (0 model calls, the folder must be new):

```bash
COUNCIL_DEV=1 COUNCIL_HOME="$PWD/.council-data/contract-$(date +%Y%m%d-%H%M%S)" node packages/mcp/scenarios/contract/check.ts
```

It starts the real server over stdio and prints `ok` or `FAIL` for the SDK pin, the protocol version, the tool list and schemas, the instructions and each response shape (a failure names the tool and the key path). Then it runs the read-only `claude mcp get osen` and `codex mcp get osen --json` from the repository root and prints one state per host: `connected` (the entry runs this repository's `packages/mcp/src/main.ts`; a relative path is resolved against the repository root; a Claude entry with node flags before the server file, e.g. `node --no-warnings <repo>/packages/mcp/src/main.ts`, is read as the server file after the flags), `not connected` (the host has no entry, or Claude reports the entry of this repository as pending approval or failed; the status text is printed), `mismatch` (the entry runs another file or command, for example the installed app's `osen-mcp`; both are printed), `not checked` (the host is missing, did not answer within 15 s or printed something unrecognized). Only the entry's command and arguments are printed, never its environment. The host checks run and print even when a contract step fails. Exit code: 1 on any contract failure or a `mismatch`, otherwise 0; `not connected` and `not checked` are warnings, because connecting a host is the owner's step (`skill/install.ts`) and the stand never changes host settings.

Updating the reference is a dedicated change only (for example an SDK upgrade together with the new protocol constant): change the constant, run `UPDATE_MCP_GOLDEN=1 npx vitest run packages/mcp/src/contract.test.ts`, review the diff of `__golden__/responses/` and describe it in that change.

## Skill for agents

The `osen` skill teaches an agent to convene a discussion of several models at the owner's request: "собери совет моделей" ("convene a council of models"), "обсуди с несколькими моделями" ("discuss with several models"), "пусть модели поспорят" ("let the models argue"), "мозговой штурм моделей" ("brainstorm of models"). The agent takes templates and providers from the server, names the topic, the participants, the round limit and the upper bound on the number of calls (participants × rounds × 3), waits for consent if the participants consume a subscription or money, starts the session, quietly waits for the result and brings back a report: status, lineup with the limit and the number of calls, decision, objections, spend and a pointer to open the session in the app. The skill does not trigger on an ordinary brainstorm with the agent itself. If the server is not connected, the agent says so and names the install command instead of answering for several models.

The skill source is `skill/osen/SKILL.md`; the trigger test phrases are in `skill/trigger-phrases.md`.

### Skill and installer language

- The skill text is a single English text: it is an instruction to the agent, not an interface, and the language choice in "Settings" does not affect it. The agent replies to the owner in the language of the owner's request: the pre-start message and report templates in the skill are English samples, the agent translates the labels, and leaves tool names, field names and server texts as they are.
- The skill description contains invocation phrases and exclusion phrases in two languages: the earlier Russian ones verbatim ("собери совет моделей", "обсуди с несколькими моделями", "пусть модели поспорят", "мозговой штурм моделей", "созови совет", "пусть Claude и Codex обсудят и договорятся"; exclusions "обсуди со мной", "что думаешь", "давай набросаем идеи для названия") and English ones ("convene a council of models", "discuss with several models", "let the models argue", "brainstorm of models", "let Claude and Codex discuss and agree"; exclusions "discuss with me", "what do you think", "let's brainstorm names"). The description is at most 1024 characters, the limit for a skill description.
- The output of `skill/install.ts` (help, preview, installation, removal, mismatches and errors) is in the current language: `COUNCIL_LANG` (`en` or `ru`) → `preferences.json` in the data folder (`COUNCIL_HOME` or the owner's folder) → English. A corrupted `preferences.json` gives English with no message. Paths, commands, agent names, exit codes and the list of actions do not depend on the language. Example: `COUNCIL_LANG=ru node skill/install.ts --dry-run`.
- The copy of the skill installed for the agents does not update itself: the new text reaches them only after a repeat installation (the preview shows "will be updated").

### Where agents keep skills and servers

| | Claude Code | Codex | Claude Desktop |
|---|---|---|---|
| Skills folder | `~/.claude/skills/<name>/SKILL.md` | `~/.codex/skills/<name>/SKILL.md` | none: skill support is not confirmed, the agent gets the rules from the MCP server instructions |
| Where servers are recorded | `~/.claude.json`, key `mcpServers` (scope `user`) | `~/.codex/config.toml`, table `[mcp_servers.<name>]`; the Codex app (ChatGPT.app) reads the same file, so one entry serves both | `~/Library/Application Support/Claude/claude_desktop_config.json`, key `mcpServers.<name>` |
| Registration | `claude mcp add --scope user osen -- node <repository>/packages/mcp/src/main.ts` | `codex mcp add osen -- node <repository>/packages/mcp/src/main.ts` | the installer writes `{"command": "<absolute node path>", "args": ["<repository>/packages/mcp/src/main.ts"]}` into the file: an app started from Finder does not see the shell `PATH` |
| Removal | `claude mcp remove --scope user osen` | `codex mcp remove osen` | the installer deletes `mcpServers.osen` from the file |
| Counts as installed | `claude` is on `PATH` | `codex` is on `PATH` | the settings file or `/Applications/Claude.app` (or `~/Applications/Claude.app`) exists |
| After a change | restart: whether a running session picks up the entry is not verified | restart | quit Claude Desktop completely and start it again |
| Peculiarity | does not overwrite an existing entry with the same name | silently overwrites an existing entry, so the installation first checks it with `codex mcp get osen --json` | the file is rewritten whole and atomically; other keys and servers keep their values and order, indentation becomes 2 spaces |

Where these facts come from (client versions, dates, documentation links): [docs/clients.md](clients.md).

### Installation

Installation writes to the agents' global settings (Node 22.18+, run from the repository root) and is done only with the owner's consent.

1. Preview: prints every entry the installation will create or change, with the full path, and changes nothing.

```bash
node skill/install.ts --dry-run
```

2. Installation: for each agent found, copies the skill into its skills folder (Claude Code and Codex only) (next to it, puts a `.osen-install` marker file with the repository path) and registers the server with the agent's own command. An agent that is not on the machine is skipped with a message. Then it removes the former `model-council` entries created by an installation from this repository before the rename: the `model-council` skill folder with the `.model-council-install` marker (this repository's path) and `name: model-council` in `SKILL.md`, and the `model-council` server that runs this repository's `packages/mcp/src/main.ts`. An agent's former entries are removed only if `osen` was set up for it without mismatches.

```bash
node skill/install.ts
```

3. Restart the clients the output names: Claude Code and Codex; Claude Desktop — quit it completely and start it again.
4. Check in Claude Code: `/mcp` shows the `osen` server (and does not show `model-council`) and seven tools; then the phrase "собери совет моделей по вопросу …" ("convene a council of models on the question …") triggers the skill.

Codex asks for confirmation to call the server's tools; in a run without a window (`codex exec`) confirmations are forbidden, and the council will not start.

Output lines: `<Agent> · skill · <action> · <path>` and `<Agent> · server · <action> · <settings file> · node <main.ts path>` (in Russian, "скилл", "сервер"); for Claude Desktop `Claude Desktop · skill · no skill: …` and `Claude Desktop · server · <action> · <claude_desktop_config.json path> · mcpServers.osen · <node path> <main.ts path>`; after a real change, a line `<Agent> · <what to do in the client>` (restart, or "not verified" when `docs/clients.md` has no confirmation); removal of the former server is the line `<Agent> · server model-council · <action> · …`, of the former folder, a skill line with the path `…/skills/model-council`. Exit codes: 0 — success, 1 — mismatch or agent CLI error, 2 — argument error.

### Removal

Preview, then removal: only its own skill folder (with the marker of this copy of the repository) and only its own server entry (the `node` command and this repository's `packages/mcp/src/main.ts` path) are removed — both `osen` and the former `model-council` ones of this installation.

```bash
node skill/install.ts --uninstall --dry-run
node skill/install.ts --uninstall
```

### Guarantees

- A repeat installation changes nothing and reports "Everything is already installed." ("Всё уже установлено." in Russian); a skill changed in the repository it updates.
- Other people's things are not touched: an `osen` folder without a marker or with the marker of another copy of the repository (the output names the path from the marker) and an `osen` server with a different path are not overwritten; a former `model-council` folder without the `.model-council-install` marker, with a different path in the marker or a different `name`, and a `model-council` server with a different path are not removed. The script reports the mismatch and exits with code 1. Other skills, servers and settings are not changed.
- A damaged settings file (not JSON, not a JSON object, `mcpServers` not an object, or unreadable) is not changed: the line names the file and the reason, the other agents are still installed, exit code 1.
- An `osen` entry of our form (`…/packages/mcp/src/main.ts` or `…/bin/osen-mcp`) whose file no longer exists is reported as a mismatch and is neither updated nor removed by the installer; the connection module's "update" action replaces it (see below).
- Claude Desktop gets the absolute path of the `node` that ran the installer (with Homebrew, a versioned `…/Cellar/node/<version>/bin/node`): after Node is upgraded the entry turns into a stale one, which the installer reports and does not touch; delete `mcpServers.osen` from the file by hand and install again, or use the app's "Update" (change 142).
- The server is registered by the absolute path of this repository: if the repository folder is moved, the installation must be repeated (first `--uninstall` from the old location, or delete the entry with the agent's command).

### Connection module

The installer and the app (Settings → Connections, change 142) share one module, `packages/connect` (`@model-council/connect`). It depends only on Node: no Electron, no MCP SDK, no `packages/mcp`. It returns codes; the texts belong to the callers.

- Clients: `claude-desktop`, `claude-code`, `codex` (the Codex app shares the Codex entry).
- The server command is a parameter `{ command, args }` and goes into the client entry exactly as given: from the repository `node …/packages/mcp/src/main.ts`, from the app the wrapper `Osen.app/Contents/Resources/bin/osen-mcp` with no `node`.
- States: `not_installed`, `not_connected`, `connected` (the entry equals the current command), `foreign` (another server, or an existing `main.ts` of another copy of the repository), `stale_path` (our server form, but its file is gone, or the same server file with another launcher), `corrupt` (the file cannot be read or parsed, or has an unexpected shape). Reading a state changes nothing.
- Actions `connect`, `update` (only from `stale_path`), `disconnect` (only our own entry, `connected` or `stale_path`), each with a `dryRun` mode that writes nothing and calls no `add`/`remove`. A repeat is a no-op; connect then disconnect returns the file to its original content by value. For Claude Code the file belongs to `claude` itself: on a `HOME` where it never ran before, `claude mcp add` also writes its own start-up keys (`firstStartTime`, `userID` and others), which stay after disconnect; `mcpServers` and the other keys return to their original values (checked with `claude` 2.1.302 in change 143). `foreign` and `corrupt` are refusals with no change; a failed CLI call, a failed write or an entry that does not match after re-reading is a `failed` refusal with the reason and the re-read state.
- A successful change also says what the owner has to do in the client: `restart_client` (Claude Desktop, Codex), `unverified` (Claude Code: `docs/clients.md` does not confirm it), `confirm_in_client`, or `none` for a no-op.
- Free connection check `checkConnection(entry)`: it starts the command recorded in the client with a temporary `COUNCIL_HOME` (the owner's data folder is not created or touched, `COUNCIL_DEV` is not passed on), sends `initialize` and `tools/list` and succeeds only if all seven `council_*` tools come back and stdout carries nothing but protocol frames. Failure reasons: `no_entry`, `spawn_failed`, `timeout` (20 seconds by default), `missing_tools`, `stray_stdout`. No model is called.

The stand `COUNCIL_DEV=1 node skill/scenarios/connection/check.ts` runs every client through these states and actions on a substituted `HOME` with fake `claude` and `codex`, then runs the real installer and the connection check; the owner's settings are not touched.

### Trial run without changing settings

Both agents and the script respect `HOME`, so with a substituted `HOME` everything is written to a temporary folder and the real settings do not change. Claude Desktop counts as installed when `/Applications/Claude.app` exists, so its settings file is then created inside the temporary `HOME` as well.

```bash
HOME=$(mktemp -d) node skill/install.ts
```

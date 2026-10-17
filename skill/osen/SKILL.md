---
name: osen
description: Use when the owner asks to convene a discussion of SEVERAL AI models that debate a topic in rounds until they agree on a shared decision - «собери совет моделей», «обсуди с несколькими моделями», «пусть модели поспорят», «мозговой штурм моделей», «созови совет», «пусть Claude и Codex обсудят и договорятся», «convene a council of models», «discuss with several models», «let the models argue», «brainstorm of models», «let Claude and Codex discuss and agree». Runs through the MCP server osen. Do NOT use for discussing an idea with the agent itself («обсуди со мной», «что думаешь», «discuss with me», «what do you think»), for an ordinary brainstorm of ideas or names («давай набросаем идеи для названия», «let's brainstorm names» - that is the superpowers brainstorming skill), for a question to one model, or for opening the app or history. Load this skill FIRST, before reading files or running commands - participant names such as live/p1.json are identifiers for the server, not files to open.
---

# osen: a council of models through the MCP server

The `osen` server runs the discussion itself: the turn order and the agreement count are deterministic. Your role: get consent to the spend, start the session, wait silently for the result and bring it to the owner without edits. Tools: in Claude Code `mcp__osen__<name>`, in Codex the tools of the `osen` server.

**Reply to the owner in the language of the owner's request.** The message and report templates below are English samples: translate their labels into the owner's language. Do not translate tool names, field names, identifiers and texts the server returned (`statusText`, `solution.text`, `reasoning`).

**Work only through calls to the four server tools.** Do not search for or read scenario, template or repository files, do not run shell commands and do not write scripts: participants and templates come from the `council_options` response, not from files (for the `scripted` provider the model is a string from its `models`, for example `live/p1.json`). The result exists only as the `council_status` response for the `sessionId` that `council_start` returned. No such response, no result: say that the discussion did not take place and why, and do not retell anything on behalf of the participants.

## Steps

1. **Check the server.** The tools may be deferred: if they are not in the list, first load them with tool search (in Claude Code `ToolSearch` with the query `select:mcp__osen__council_options,mcp__osen__council_start,mcp__osen__council_status,mcp__osen__council_stop`), then call them. If the tools `council_options`, `council_start`, `council_status`, `council_stop` are absent and the search did not find them, say: “The `osen` server is not connected”. Name the install command: if a `.osen-install` file lies next to this `SKILL.md`, take the path from it and give `node <path>/skill/install.ts`; if there is no such file, give `node skill/install.ts` from the root of this repository (preview `--dry-run`). Do not run it yourself. Do not imitate the discussion: an answer “on behalf of several models” is a fake, not a council.
2. **Call `council_options`** (no arguments). Take template and provider identifiers and model names only from the response; do not invent them.
3. **Choose a template.** Only if a description in `templates[]` clearly fits the topic (for example, a choice between two solutions and there is a choice template): then `templateId` and its name go into the message before the start. Not sure: no template, neutral framing.
4. **Choose the participants.** If the owner named them, take the named ones. Otherwise `defaults.participants`. Providers with `available: false` do not join. A default participant is unavailable: name its `reason` and propose a roster of the available ones if there are at least two. Fewer than two: say that the start is impossible and name the reasons. For `cli` the model may be omitted (`defaultModel`); for `openai-http` and `scripted` the model is required.
   The owner's saved lineups: `lineups` from the `council_options` response.
   - The owner named a lineup (“with the Review lineup”, “with the same lineup as …”): find it in `lineups` by `name`; do not assemble the participants yourself, the start goes by `lineupId`.
   - The lineup has `available: false`: do not start it and do not substitute other participants for its positions. Name the unavailable positions and their `reason` to the owner; offer another lineup or an ordinary start only as a question.
   - The named lineup is not in `lineups`: say there is no such lineup and list the existing names. Do not start the default participants instead without the owner's consent.
   - `lineupsError` is not `null`: say that the lineups file is corrupted (give the reason), a start by lineup is impossible, an ordinary start works.
   - The owner did not name a lineup: choose the participants as before, do not pass `lineupId`.
5. **Count the spend.** The upper bound on the number of model calls = participants × `maxRounds` × 3 (turn, retry, fix); the server returns the same number in the `council_start` response as `maxCalls`. `maxRounds` comes from `defaults` or from the owner (1–20). Kinds: `cli` consumes the owner's subscription, `openai-http` is paid (count it as paid even if the endpoint may be local), `scripted` is free.
6. **The message before the start: always, in every case.** First write to the owner the topic, the participants, the template, the round limit and the upper bound on the number of model calls (template below), and only then call `council_start`. Calling `council_start` without this message is a violation, even when consent is not needed. The last line of the message depends on the case:
   - there is a `cli` or `openai-http` participant: “Start?” — and wait for the answer; do not call `council_start` in this reply. Refused: do not start the session, say that it was not started;
   - the owner named the participants and allowed the start in the same request: “Starting, as you said.” — and call it right away (a lineup named by the owner counts as named participants);
   - all participants are `scripted`: “The session is free, starting.” — and call it right away.
   For a start by lineup, list the participants by the lineup's positions: the provider, model and role of each, and name the lineup. Count the spend by the positions' `providerId` (the provider kind is in `providers` of the same response). Give the positions' `modelNote` notes in the message.
   If the owner named files or folders (“on this file”, “on the diff”, “on the docs folder”), these are materials: add a “Materials” line to the message with the number of paths and their size in characters (the limit is `defaults.materialsChars` from `council_options`). Materials go into every call of every participant and increase the spend. A folder can be attached even when it is larger than the limit: only the initial set goes into each call. Attach only what the owner named or clearly meant; add nothing yourself.
7. **Call `council_start`**: `{ topic, templateId?, participants?: [{ providerId, model? }], lineupId?, maxRounds?, attachments? }`. At least two participants. For a lineup, pass `lineupId` and omit `participants`: do not pass `lineupId` and `participants` together, the server rejects the call even when the lists match. Roles come from the lineup; the template sets only the framing. The response has `lineup`: `{ id, name, notes }`; give `lineup.notes` to the owner in the report. `attachments` are absolute paths to the owner's files and folders (the server rejects a relative path: its working folder is not the project); do not paste file text into the topic. The response has `materials`: `count` and `chars` — how many materials were collected and their size, `skipped` — what was skipped and why; name the skipped items to the owner in the report. For a folder the response has `folder` (the number of files and the snapshot size) and `materials.left` (how many files of the folder did not fit into the initial set and the first 20 with reasons): the participants read them on request; name the snapshot size and the number of files that did not fit to the owner. A collection refusal (path not found, an `.env` environment file, a non-text file, explicitly named files larger than the limit, or a folder larger than the snapshot bound) is a tool error with reasons: retell them and do not start without these files until the owner decides. Always pass `maxRounds`: exactly the number you named to the owner, otherwise the template may set its own limit. Pass the topic in the owner's words: add nothing of your own — no options, no criteria, no clarifications; add context only if the owner gave it in this conversation. A tool error: retell the reason, fix the input, retry once. Remember the `sessionId`. Do not write a separate line about the start: the message from step 6 replaces it. If you did skip the message from step 6, the very first text after the start names the participants, the round limit and the upper bound on calls (`maxCalls` from the response).
8. **Wait for the result.** Call `council_status` with `{ sessionId, waitSec: 50 }` in a loop while `status` is `running`. The server does not wait longer than 50 seconds, and a long tool call runs into a timeout. Between `council_status` calls write nothing to the owner: no “waiting”, no “turn finished”, no who agreed. Any text of yours between calls reaches the owner as a separate message. After the message from step 6, your next text is the final report. The only exception: the session runs longer than 5 minutes, then one status line every 5 minutes (“round N of M, K of P agree”).
9. **Stopping.** The owner asked to stop: `council_stop` with `{ sessionId }`, then a report on the state from the response.
10. **Report.** As soon as `status` is not `running`, give the report (template below) and call nothing else.

## Message before the start

```
Topic: <topic>
Lineup: “<name>” (line only for a start by lineup)
Participants: <name (provider, model, role)>, ... (spend: subscription / paid / free)
Template: <name or “no template”>
Limit: <N> rounds. Upper bound: <N × participants × 3> model calls.
Materials: <number of paths>, about <size> characters — they go into every call. (line only with attachments)
<Start? | Starting, as you said. | The session is free, starting.> I will bring the result when they finish.
```

## Report

```
Status: <statusText>. Rounds: <rounds>, turns: <turns>.
Lineup: <participant names> (spend: subscription / paid / free); limit <maxRounds> rounds, up to <maxCalls> model calls.
Decision (version <version>):
<solution.text in full>
Spend: <duration>, tokens in/out <..>/<..>, cost <..> USD
The session can be opened in the Osen app, the History section (source MCP).
```

- The “Lineup” line is required in every report, with any status: names from `participants[]`, `maxRounds` and `maxCalls` from the `council_start` response. This way the owner sees the roster, the limit and the number of calls even if the message before the start did not arrive.
- For a start by lineup, name the lineup in the “Lineup” line; give `lineup.notes`, if any, on a separate line.
- `consensus`: the decision in full, as the server returned it.
- `no_consensus`: the first line is “No consensus”. Then the last version, then `objectors[]`: the name and `reasoning` of each.
- `failed`: the reason from `reason`. Do not give or invent a decision.
- `stopped`, `interrupted`: “the session did not reach the end”. Give the last version from `solution` (if there is one) and say that it is not agreed.
- If the response contains `ownerSelection`, it is the owner's choice made in the app: give it separately from the status and do not call it the models' consensus.
- Take the spend from `stats`; skip fields with null, do not estimate them.
- The session lives in the server process: if the agent is closed, the session gets the status “interrupted”. Tell the owner this if they are about to close the agent before the result.

## Failure modes

| Thought | What to do |
|---|---|
| “I'll answer for three models myself, it's faster” | Not allowed. Call the server or say that it is not connected |
| “The tool does not respond, I'll assemble the result from files or from what I know” | Not allowed. Without a `sessionId` and a `council_status` response there is no result. Say that the discussion did not take place |
| “I'll find the participant files and look inside” | Not needed. The participant name is passed to the server as is, from `council_options` |
| “I'll start right away, the owner asked for a council” | A request without named participants and permission is not consent to spend a subscription. Show the request |
| “Scripted participants, but I'll ask just in case” | All `scripted`: start right away, they are free |
| “I'll tell the owner about every turn” or “I'll say that I'm waiting” | No. Between `council_status` calls stay silent: call the next one without text. The message before the start, then straight to the result |
| “The participants are named and free, I'll start silently” | No. The message before the start is always written: the owner must see the roster, the limit and the number of calls before the start |
| “I'll refine the topic so the discussion is richer” | No. The topic goes in the owner's words, add nothing of your own |
| “I'll set a bigger `waitSec`” | The server truncates it to 50, no more |
| “No consensus, but the version is good, I'll present it as the decision” | Not allowed. Say “no consensus” and give the objections; do not present the last version as an agreed decision |
| “I'll polish the wording of the decision” | Do not edit or add to it. Your own remarks go on a separate line after the report, marked as yours |
| “There is no suitable template, I'll take a similar one” | No template |
| “The provider is unavailable, I'll silently substitute another” | Name the reason and propose a roster |
| “The lineup is unavailable, I'll assemble a similar one from the available ones” | Not allowed. Name the reason (`reason`) and ask the owner |
| “I'll pass both `lineupId` and `participants` to be safe” | Not allowed, the server rejects it. Only `lineupId` |
| “The topic is short, I'll set a bigger round limit myself” | Take `defaults` or the owner's word; only the owner changes the limit |

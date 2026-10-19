# The `council` command

Runs a discussion from the terminal: participants take turns editing a shared decision until they agree, and the progress is printed as it goes. Participants are `claude` and `codex` (installed CLIs, see [docs/participants.md, "CLI participants"](participants.md#cli-participants)), models behind an HTTP endpoint (see [docs/participants.md, "HTTP participants"](participants.md#http-participants)) and scripted `scripted` participants.

```bash
COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "Как назвать кота" --participant scripted:packages/core/scenarios/consensus/p1.json --participant scripted:packages/core/scenarios/consensus/p2.json --max-rounds 3
```

Expected: three turns, versions 1 and 2, the line `══ Outcome: consensus` and exit code 0.

- Participant: `--participant [name=]<provider>[:<model>]`, the flag is repeated, the order sets the queue, at least two are required. The provider is an identifier from `config.json` (`claude`, `codex`) or `scripted:<scenario file>`; if no model is given, the CLI's default model is used. Examples: `claude`, `codex:<model>`, `Ann=claude:haiku`. The default name is the provider name (with the model, if one is given), and for `scripted` it is `Participant N`. Without `--participant`, the default participants from `config.json` are used.
- Required flag: `--topic`. Optional: `--template`, `--max-rounds`, `--turn-timeout` (seconds, an integer from 1 to 2147483), `--context-chars` (by default from the template, otherwise from `config.json`), `--attach`, `--include`, `--no-ignore`, `--url`, `--preview-materials`, `--prepared-materials` and `--materials-chars` (see [docs/materials.md, "Materials"](materials.md#materials)), `--framing` (by default the template's framing, without a template a neutral one), `--drafts` and `--synthesizer <pN>` (see ["Independent drafts (experiment)"](#independent-drafts-experiment)). Full help: `npx council --help`.
- Turn context and `--context-chars`. The limit trims only the turn log: in a long session the earliest turns drop out of the request with the note «[Early turns omitted due to the context limit: N]». The limit does not trim the "Positions on the current version" section: for each active participant it contains «agrees», «objects (turn N)» with the verbatim arguments of the latest objection to the current version, or «no current position on version N». An objection longer than 2000 characters is shown as its first 2000 with the note «[showing the first 2000 of M characters, turn N]». With participant names up to 40 characters, the section adds no more than 6700 characters to the request with 3 participants and no more than 17450 with 8 (all of them objecting with text of 2000 characters or more; long names add their length for each participant); a line for an agreeing participant is a few dozen characters, for an objecting one it is the length of their arguments. A turn "agree with questions" that was counted as an objection is marked in the section the same way as in the log. In the record of a participant's answer shown to a participant, the text of the question (up to 500 characters, with the same note) stands next to the answer, so the answer is clear even when the turn with the question has been dropped; this record counts toward the log limit. In an English session the section is called "Positions on the current version".
- Lineups: `--lineup <id>` takes participants from a saved lineup instead of `--participant` (together they give code 2); `council lineups` and `council lineups save <name> --from-session <id>` list and save lineups. Description: ["Lineups"](#lineups).
- `scripted` works only with `COUNCIL_DEV=1`; the variable is taken from the process environment or from `.env` (the data folder first, then the current folder).
- A scenario is JSON `{ "steps": [...] }`; a step is one of four kinds: `{ "response": {...} }`, `{ "raw": "text" }`, `{ "error": "message" }`, `{ "timeout": true }`; any step can set `delayMs` and `expectPrompt` (text that must be in the request to the participant, otherwise the call fails without retries). Ready-made examples: `packages/core/scenarios/`.
- `Ctrl+C` stops the session with the status `stopped`; `council stop <id>` from another terminal does the same; `council say <id> <text>` sends the owner's message to a running session (see ["Owner's message"](#owners-message)), `council say <id> --answer <qN> <text>` answers a participant's question to the owner (see ["Questions to the owner"](#questions-to-the-owner)); `council resume <id>` continues an interrupted, stopped or no-consensus session (see ["Resuming a session"](#resuming-a-session)).
- A real run spends Claude and Codex subscriptions: up to `participants × rounds × 3` calls. Run it only deliberately:

```bash
COUNCIL_HOME=.council-data npx council --topic "Как назвать кота" --participant claude:haiku --participant codex --max-rounds 2
```

- Provider state (no model is called):

```bash
COUNCIL_HOME=.council-data npx council providers
```

  An HTTP provider has a different block: `id  openai-http  available | unavailable: reason  address`, a `key:` line and a `models:` line without `default` (see [docs/participants.md, "HTTP participants"](participants.md#http-participants)). A CLI provider gets one block per provider: `id  cli  available | unavailable: reason  version  path`, then a warning (if any), a `models:` line (always starting with `default`) and, if the model list is not confirmed, the reason. If the registry is empty, the line «No providers: …» is printed.
- Discussion templates (no model is called):

```bash
COUNCIL_HOME=.council-data npx council templates
```

```bash
COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "Переписать модуль отчётов с нуля или чинить по частям" --template refactoring-plan --participant scripted:packages/core/scenarios/consensus/p1.json --participant scripted:packages/core/scenarios/consensus/p2.json
```

  The first command prints one line per template: `identifier  category  title  source`. After the line `Topic: …`, the second prints `Template: refactoring-plan` and ends with the line `══ Outcome: consensus`. The file format and error breakdown: [docs/templates.md](templates.md).
- Subcommands (each saves and reads sessions from the data folder, see [docs/data.md, "Data"](data.md#data)):

```bash
COUNCIL_HOME=.council-data npx council list
COUNCIL_HOME=.council-data npx council show <id>
COUNCIL_HOME=.council-data npx council stop <id>
COUNCIL_HOME=.council-data npx council say <id> "текст реплики"
COUNCIL_HOME=.council-data npx council say <id> --answer q1 "текст ответа"
COUNCIL_HOME=.council-data npx council status <id>
COUNCIL_HOME=.council-data npx council continue <id>
COUNCIL_HOME=.council-data npx council home
```

`list` prints one line per session, newest first: `id  date  status  source  start of the topic`; `show <id>` prints the turns and state of the session, and if the owner accepted a version in the app, a separate «Owner's choice» block with the version number and text, the note, the time and the outcome at the moment of the choice (the status and the discussion result are printed as before; the choice is not called agreement); `status <id>` is brief: status, round, number of turns and the current owner wait with its reasons, questions and deadline; `continue <id>` releases the current owner wait of a running session (see ["Waiting for the owner"](#waiting-for-the-owner)); `stop <id>` requests a stop of a running session; `say <id> <text>` sends the owner's message to a running session (`say <id> --answer <qN> <text>` answers a participant's question); `home` prints the data folder path (it does not create the folder).

When a journal was not read in full, `list`, `status` and `show` mark it after the status: «the journal was written by a newer version, read up to event No. N» (the line is intact but unknown to this app version: a newer version appended to the journal) or «the journal is corrupted, read up to event No. N» (a broken or truncated record). For a session of a newer version with no recorded result, instead of «running» and «interrupted» they print `state undetermined · the journal was written by a newer version, read up to event No. 3`, and `status` and `show` add the line «Update the app to read the whole session.» (`list` prints it after the list). If the result was recorded before the unreadable line, it is printed with the same mark, for example `consensus · the journal was written by a newer version, read up to event No. 7`. `resume`, `say` and `continue` reject such a session with code 2 and a message about the newer version (the journal does not change); `stop` is accepted while the executor is running. Check without cost (0 model calls, real `council` and MCP processes over stdio, scripted participants):

```bash
COUNCIL_DEV=1 node packages/core/scenarios/newer-version/check.ts
```

| Code | Meaning |
|---|---|
| 0 | consensus |
| 1 | internal error |
| 2 | argument error, unknown session, rejected stop, rejected message, rejected answer to a question, rejected release of a wait, error in config.json, unavailable provider, unknown template, unknown or unavailable lineup, lineup save refusal, materials refusal |
| 3 | no_consensus |
| 4 | stopped |
| 5 | failed |

## Machine output (--json)

For agents and scripts: `status <id>`, `list`, `show <id>`, `providers`, `templates`, `lineups` and `doctor` accept `--json`. Stdout then carries exactly one JSON document on one line, ended with a newline, and nothing else; warnings, diagnostics and errors go to stderr, and on an error stdout is empty. Exit codes are the same as for the text output (see the table in ["The `council` command"](#the-council-command) above). Other commands (a plain launch, `resume`, `say`, `stop`, `continue`, `home`, `lineups save`) reject `--json` with a reason and help, code 2, and do nothing: no session is created, no journal changes.

```bash
COUNCIL_HOME=.council-data npx council list --json
COUNCIL_HOME=.council-data npx council status <id> --json
COUNCIL_HOME=.council-data npx council show <id> --json
COUNCIL_HOME=.council-data npx council providers --json
COUNCIL_HOME=.council-data npx council templates --json
COUNCIL_HOME=.council-data npx council lineups --json
```

- Keys, status names, reason codes and identifiers do not depend on `COUNCIL_LANG`; free text (topic, decision text, objections) is passed as is. With `COUNCIL_LANG=en` and `ru` the document is byte-for-byte the same, with two exceptions: `templates` takes `title` and `category` (and their order) from the template files of the selected language, provider diagnostics (`reason`, `warning`, `modelsReason` in `providers` and `doctor`) are written in the selected language as in the text output, and `doctor` reports the selected `language`.
- Every document has `schemaVersion` (an integer, now `1`) and only the facts the text output already prints. An absent value is `null`, never a missing key.
- `status` is the original session status name: `running`, `consensus`, `no_consensus`, `stopped`, `failed`, `interrupted`, not a translated label.
- A session whose journal was not read in full has `partial` = `{reason, lastEvent}` (otherwise `null`). A session of a newer version is recognised by `partial.reason == "newer_version"`; treat its state as undetermined, as the text output does.
- `providers` never contains a key value, only the variable name (`keyEnv`) and the flag (`keySet`).

Schemas:

```
list:      {schemaVersion, sessions: [{id, createdAt, status, origin, topic, partial}]}
             topic is complete, not shortened; partial: null | {reason, lastEvent}
status:    {schemaVersion, id, status, partial, round, maxRounds, turns, waiting}
             waiting: null | {waitId, reasons, questions: [{id, from, text}], deadline}
show:      {schemaVersion, id, status, partial, finish, currentVersion, agreed, waiting, ownerSelection, totals}
             finish: null (running session) | {status, reason, agreed, objecting}
             currentVersion: null | {number, authorId, text}
             ownerSelection: null | {version, ts, note, statusAtSelection}
             totals: {turns, drafts, durationMs, inputTokens, outputTokens, costUsd, incomplete}
providers: {schemaVersion, providers: [{id, kind, label, available, reason, warning, path, version,
                                        baseUrl, keyEnv, keySet, models, modelsConfirmed, modelsReason}]}
templates: {schemaVersion, templates: [{id, category, title, source}], errors: [{file, source, reason}]}
             source: "builtin" | "user"
lineups:   {schemaVersion, lineups: [{id, name, participants: [{providerId, model, role}]}]}
```

`show` has no turn feed; `totals` hold the same values as the totals line of the text output. With no sessions or lineups, `list` and `lineups` print an empty array and exit with code 0. `list` shows the sessions with a partly read journal along with the rest, code 0.

Example, `list` (the document is on one line; wrapped here):

```json
{"schemaVersion":1,"sessions":[
  {"id":"0eccca17-9f71-4aac-9e14-52fe43737a0a","createdAt":"2026-05-12T09:30:00.000Z","status":"consensus","origin":"cli","topic":"Как назвать кота","partial":null},
  {"id":"18fd7e46-67ad-40b0-8d0e-826faa88f9b2","createdAt":"2026-05-11T16:02:10.000Z","status":"running","origin":"mcp","topic":"Выбрать базу данных","partial":{"reason":"newer_version","lastEvent":3}}]}
```

Example, `show` of a finished session (wrapped here):

```json
{"schemaVersion":1,"id":"0eccca17-9f71-4aac-9e14-52fe43737a0a","status":"consensus","partial":null,
 "finish":{"status":"consensus","reason":null,"agreed":["p1","p2"],"objecting":[]},
 "currentVersion":{"number":2,"authorId":"p2","text":"Назвать кота Рыжик."},
 "agreed":["p1","p2"],"waiting":null,"ownerSelection":null,
 "totals":{"turns":3,"drafts":0,"durationMs":1200,"inputTokens":0,"outputTokens":0,"costUsd":0,"incomplete":false}}
```

## Diagnostics: council doctor

`council doctor` prints the facts needed to see why a run does not start. No model is called and no session journal is written.

```bash
COUNCIL_HOME=.council-data npx council doctor
COUNCIL_HOME=.council-data npx council doctor --json
```

Without `--json` it prints the same facts as labelled lines in the interface language. The `--json` document is `{schemaVersion, binary, runtime, language, dataDir, config, providers}`:

```
binary:    {execPath, entry, version}
             execPath — the executable of the process, entry — the script that was run,
             version — the app version from apps/desktop/package.json; null if the entry point did not pass it
runtime:   {mode, node}
             mode — "packaged" if the process is the packaged app in Node mode (decided by process.versions.electron), else "node"
             node — the Node version
language:  the selected output language
dataDir:   {path, exists, writable}
             exists — the folder existed before this call (the call creates it, as `providers` does)
             writable — a write-permission check, no files are created
config:    {path, created}
             created — true if this call created the file (the same way as `providers`)
providers: the same items as in `providers --json`: availability, version, reason for unavailability, warning
```

- Key values never appear in the output.
- An unavailable provider does not change the exit code: it is shown with its `reason`, the rest is printed, code 0; provider warnings also go to stderr.
- An inaccessible data folder gives the reason in stderr, code 1 and empty stdout; a broken `config.json` gives code 2 — the same codes and reasons as `council providers`.

## Owner's message

While a discussion runs in one terminal, you can send a message from another: `council say <id> <text>`. The message is queued and applied after the current turn; the running turn is not interrupted. An `owner_message` event appears in the journal; everyone who agreed must speak again, so consensus requires fresh agreement from every active participant. Participants see all messages in every following request and know that the owner's message outranks the participants' opinions.

The text is a single argument and is passed as is (spaces and line breaks are preserved). Text that starts with a hyphen goes after `--`: `council say <id> -- "-минус в начале"`. The command does not need the provider registry: it neither reads nor creates `config.json`.

On success the command prints `Message for session <id> requested: participants will see it from the next turn.` and returns 0. This confirms that the request was queued, not that a participant has already seen the message. Refusal (code 2, message in stderr without help):

- `The message must not be empty.` — the text is empty or only whitespace;
- `Session <id> not found.`;
- `Session <id> is already finished: <status>.`;
- `Session <id> was interrupted: its executor is not running.`;
- the session does not accept messages right now (the executor is finishing the discussion or was started by a version without messages).

The request could not be written — `Error: could not write the message — <reason>`, code 1. Wrong number of arguments — the reason and help, code 2.

In the output (of a running discussion and of `council show`) the message stands at its chronological place and differs from a turn line:

```
── Owner · o1 · after turn 2
Имя должно быть коротким, до пяти букв
```

Example with scripted participants (0 model calls). First terminal:

```bash
COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "Назвать кота" --participant scripted:packages/core/scenarios/owner-message/p1.json --participant scripted:packages/core/scenarios/owner-message/p2.json --max-rounds 3
```

Second terminal:

```bash
COUNCIL_HOME=.council-data npx council list
COUNCIL_HOME=.council-data npx council say <id> "Имя должно быть коротким, до пяти букв"
```

The second participant's turn in this scenario lasts 8 seconds; that is the window for the second terminal. Without a message the session ends in consensus after turn 2.

## Questions to the owner

A participant can ask the owner about something the participants cannot decide themselves (missing facts, preferences). In the output of a running discussion the question stands in the turn line, with a hint; in `council show` it is the same line without the hint:

```
Question to the owner · q1 · p1 «Participant 1»: В каком формате нужен отчёт: таблица или текст?
  answer: council say <id> --answer q1 "<text>"
```

The answer is an owner's message tied to the question: `council say <id> --answer <qN> <text>`. On success the command prints `Answer to question qN for session <id> requested: participants will see it from the next turn.` and returns 0; the running turn is not interrupted. The answer, like any message, resets those who agreed, and the question is closed as answered. In the output it looks like this: `── Owner · o1 · after turn 2 · answer to q1`, with the text below.

Without the `--wait-for-owner` flag (see ["Waiting for the owner"](#waiting-for-the-owner)) the discussion does not wait for an answer. If there is no answer by the next turn of the participant who asked, the question is closed unanswered (in the output, the line `  question q1 was left unanswered`), the list of agreeing participants is reset, and the participants decide on their own. An open question to the owner, like any open question, prevents consensus.

Refusals (code 2, the journal does not change): `Question qN not found.`; `Question qN is not addressed to the owner.`; `Question qN is already closed: answered.`; `Question qN is already closed: left unanswered.`; for a finished, interrupted and unknown session, the same reasons as for a message. `--answer` without a value — the reason and help, code 2.

Example with scripted participants (0 model calls). First terminal:

```bash
COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "Выбрать формат отчёта" --participant scripted:packages/core/scenarios/owner-questions/answer-p1.json --participant scripted:packages/core/scenarios/owner-questions/answer-p2.json --max-rounds 3
```

Second terminal, during turn 2 (the second participant thinks for 8 seconds):

```bash
COUNCIL_HOME=.council-data npx council say <id> --answer q1 "Формат — таблица"
```

The scenarios `silent-p1.json` and `silent-p2.json` in the same folder give a discussion in which the owner stays silent.

## Waiting for the owner

By default the discussion runs without stops. Two launch flags turn on a finite wait for the owner between turns; they can be set together:

- `--pause-after-round` — after every round, if there is no result yet and a next round exists, the discussion waits for the owner;
- `--wait-for-owner` — if a participant asked the owner a question, the nearest next turn waits for the answer;
- `--owner-wait-sec <N>` — the duration of one wait in seconds, an integer from 1 to 86400; without the flag, 300. The flag is not accepted without one of the two modes.

While the discussion waits, no models are called and there is no spend; the session status stays "running". Before the first turn the launch prints the line `Owner wait: …, period N s. When it expires the discussion will continue on its own within the round limit.` — an expired deadline does not stop the discussion but continues it without you, within the round limit already agreed. After the last turn of the last round, on consensus, failure and stop, there is no wait.

The start of a wait in the launch output:

```
⏸ Owner wait w1 · pause after the round; question to the owner (q1) · until 2026-10-09T12:39:34.067Z
  continue: council continue <id>
  answer: council say <id> --answer q1 "<text>"
```

What you can do from a second terminal:

| Command | What happens |
|---|---|
| `council status <id>` | Shows the wait: identifier, reasons, held questions, deadline and how much is left. Changes nothing |
| `council say <id> "<text>"` | The message is recorded and resets those who agreed, but does not release the pause |
| `council say <id> --answer q1 "<text>"` | The question is closed as answered. If there are no other reasons to wait, the discussion continues (`▶ Wait w1 released: answer received`), otherwise the pause after the round remains |
| `council continue <id>` | Releases the whole wait: unanswered held questions are closed without an answer, the discussion continues (`▶ Wait w1 released: the owner continued`) |
| `council stop <id>` | Stops the session: status `stopped`, no new turns |

`continue` is not `resume`: it starts nothing and adds no rounds, it only releases a discussion that is already running; `resume` of a running session is still rejected. `continue` for a session without a wait, a finished, interrupted or unknown one is a refusal with a reason, code 2.

If the discussion process closed during a wait, the session becomes "interrupted" and the wait is kept with its previous deadline: `council status <id>` shows it, `council resume <id>` keeps waiting until the same deadline (a new deadline does not start), and if the deadline has already passed, it immediately closes the unanswered questions and goes on. `continue` requests not applied before the process closed are not carried over.

Example with scripted participants (0 model calls). First terminal — the discussion will stop after the first round:

```bash
COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "Формат отчёта" --participant scripted:packages/core/scenarios/owner-wait/plain-p1.json --participant scripted:packages/core/scenarios/owner-wait/plain-p2.json --max-rounds 3 --pause-after-round --owner-wait-sec 120
```

Second terminal:

```bash
COUNCIL_HOME=.council-data npx council status <id>
COUNCIL_HOME=.council-data npx council continue <id>
```

Full check with separate processes (pause, question, deadline, executor death and resume, stop, simultaneous requests; about 20 seconds, a new data folder inside the project):

```bash
COUNCIL_DEV=1 COUNCIL_HOME="$PWD/.council-data-acceptance-33-$(date +%Y%m%d-%H%M%S)" node packages/core/scenarios/owner-wait/check.ts
```

In the app the wait is turned on in "Session setup" and controlled by the "Waiting for the owner" panel on the discussion screen — see [docs/desktop.md, "Desktop app"](desktop.md#desktop-app). The panel also controls a session started by the `council` command with the same data folder. The MCP server turns the wait on at start (`council_start`), shows it (`council_status`) and releases it (`council_continue`), see [docs/mcp.md, "MCP server"](mcp.md#mcp-server). App versions built before the wait appeared (0.4.0 and earlier) read the journal of such a session only up to the first wait event.

## Resuming a session

`council resume <id> [--rounds <n>] [--max-tokens <n> | --no-max-tokens] [--replace <pN>=<entry>]…` continues a saved session with the status `interrupted`, `no_consensus` or `stopped` (or `failed` after the "fewer than two active participants" failure, see below) from the same place and under the same identifier: there is no new session, a `session_resumed` event is added to the journal, and turn and round numbers continue. The topic, framing, template and limits do not change; the lineup changes only with the `--replace` flag, so the command does not accept the other launch flags (`--topic`, `--participant`, `--max-rounds` and so on): code 2 with help.

`--rounds` is how many more rounds to run, counting the unfinished one. Without the flag, the remainder of the previous limit is used. Example: limit 4, one round fully completed — `resume <id>` runs 3 more rounds, `resume <id> --rounds 2` runs 2 rounds (the new total limit is 3). Before the first call the command prints `Continuation of session <id>: <n> more rounds (total limit <m>), no more than <k> model calls (active participants <a> × <n> × 3).`; dropped-out participants are not counted.

Carried over: the current version, agreeing participants, questions and answers, dropped-out participants, owner messages, materials (taken from the session snapshots, the source files are not needed). An interrupted turn is repeated from the beginning. Messages queued with `council say` but never applied (the executor was killed) are deleted: the command prints their number and texts, so send them again.

If the session was interrupted or stopped in the independent drafts phase (see ["Independent drafts (experiment)"](#independent-drafts-experiment)), it resumes from the first unfinished draft, and the call bound in the plan line includes the remaining draft calls; the command names it separately.

Participant replacement. `--replace <pN>=<entry>` (repeatable; the entry is the same as for `--participant`) replaces a dropped-out participant or an active one whose provider is currently unavailable. An available active participant cannot be replaced. The previous participant keeps its identifier and history; the new one gets the next free identifier, the place in the turn order and the role of the previous one (identifiers are issued in the order of seats, not of flags). A participant that has already been replaced cannot be replaced again — only the current one. Before the turns the lines `Replacement: p2 «<name>» → p3 «<name>» (<provider>:<model>) — reason: <unavailable: … | dropped out: …>`, `Agreements reset: all active participants confirm the current version again.` and `Active lineup: …` are printed. All agreements are reset; open questions addressed to the previous participant are closed as `replaced`; versions, turns, token spend, the ceiling, drafts and the owner wait deadline do not change. The interrupted turn of a replaced active participant is not repeated: the new participant takes a turn at this place in the same round; a turn that ended with the participant dropping out counts as skipped — the new participant goes from the next pass of the queue. In the drafts phase the new participant inherits the previous one's slot: an accepted draft is not repeated, an unfinished one continues with the remainder of its three calls; the synthesizer role is not inherited (while version 1 does not exist and the synthesizer is not active, the `synthesizer` refusal remains). In the journal this is a single `session_resumed` event with the `replacements` field. An app version that does not know this field shows the previous lineup for such a session: update the app before opening such sessions (`docs/deploy.md`); there is no replacement choice in the app.

A session with the status `failed` can be resumed only if `session_finished` records a `reasonCode` of `insufficient_active_participants` (fewer than two active participants remain) and the replacements bring back at least two active ones; after such a failure `council` suggests the command `council resume <id> --replace <pN>=<provider>:<model>`. Without enough replacements the `too_few_active` refusal names the dropped-out participants. Other failures, like `failed` in old journals without `reasonCode`, are not resumed.

Example with scripted participants (0 model calls): participant p2 dropped out, one active participant remained, the session ended in failure; resume with a replacement.

```bash
COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council resume <id> --replace p2=scripted:packages/core/scenarios/resume/p2.json
```

Refusal (code 2, reason in stderr without help): the session is not found; it is running; consensus has already been reached or it ended with a failure other than "fewer than two active participants"; fewer than two active participants and the replacements do not fix it (`too_few_active`); the replacement is rejected (code `replacement`: a repeated or unknown `pN`, `pN` already replaced, the participant is available, the new participant is unavailable or written incorrectly, the number of participants is exceeded); no rounds remain and `--rounds` is not given; the participant's provider is unavailable; the materials snapshot is missing or does not match the hash; the snapshot of an accepted draft is missing or damaged (code `draft`); the synthesizer dropped out without creating version 1 and the result was not recorded in time (code `synthesizer`); the journal is damaged; the journal was written by a newer version (code `newer_version`); another process is already resuming the session. Further, the output and codes are the same as for a normal run: 0 `consensus`, 3 `no_consensus`, 4 `stopped` (including by `Ctrl+C`), 5 `failed`, 1 internal error. `council show <id>` prints the whole history and the line `Total: turns …, duration …`; `list` and `show` show «running» during a segment.

Example with scripted participants (0 model calls): two rounds without consensus, then one more round.

```bash
COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "Как назвать кота" --participant scripted:packages/core/scenarios/resume/p1.json --participant scripted:packages/core/scenarios/resume/p2.json --max-rounds 2
COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council resume <id> --rounds 1
```

The first command ends with `no_consensus` (code 3), the second with `consensus` on the previous version (code 0). The scenarios `slow1.json` and `slow2.json` give a 20-second turn: during this time you can stop the session or kill the executor and see the turn repeated. Materials check on resume: `COUNCIL_DEV=1 node packages/core/scenarios/resume/check.ts`. Participant replacement check (real `council` and MCP over stdio, scripted participants, 0 model calls; the stand creates its own data folder inside `.council-data/`): `COUNCIL_DEV=1 node packages/core/scenarios/replacement/check.ts`; `--prepare-only` only prepares the initial data (a session with a "fewer than two active" failure and a stopped session with an unavailable participant) and prints the folder, `--keep` leaves the folder after the check.

## Lineups

A lineup is a named set of participants: ordered positions "provider, model, role". It is stored separately from topic templates: a template sets the framing and the roles in order, but not the models and providers; a lineup sets who takes part. Changing a template does not change a lineup.

The `lineups.json` file lives in the data folder next to `config.json`; the format is a JSON array:

```json
[
  {
    "id": "0f3c…",
    "name": "Ревью",
    "participants": [
      { "providerId": "claude", "model": "default", "role": "Критик" },
      { "providerId": "codex", "model": "default", "role": null }
    ]
  }
]
```

`id` is issued by the program on save (a UUID). `name` is a single line of up to 100 characters; names are unique (compared exactly, leading and trailing spaces are dropped). There are at least two positions, `role` is a string or `null`, extra fields are an error. The file holds no keys, topic or material paths. No file means no lineups; it is not created on read. A damaged file is neither repaired nor replaced with an empty one by the program: the lineup commands and a start by lineup answer with the reason (code 2), a regular start without a lineup does not depend on the file; the owner edits or deletes the file. Writing is atomic, under the `lineups.lock` lock: concurrent saves do not lose each other. The command has no delete or rename: the file is edited by hand.

```bash
COUNCIL_HOME=.council-data npx council lineups
COUNCIL_HOME=.council-data npx council lineups save "<name>" --from-session <id>
COUNCIL_HOME=.council-data npx council --topic "<topic>" --lineup <lineup id>
```

- `lineups` — the list: `<id>  <name>` and the positions `  N. <provider>:<model> — <role>`. Providers are not inspected for this.
- `lineups save` saves a lineup from the participants of the given session (any status, all participants in their order, including those who dropped out). Only the provider, model and role are copied; the participants are not called, the session journal does not change. Answer: `Lineup <id> «<name>» saved: participants N.` Refusal (code 2): the session is not found or its journal is damaged; the name is empty, multi-line, longer than 100 characters or taken; the lineups file is damaged.
- `--lineup <id>` starts a discussion by a lineup: participants, models, roles and order are taken from it; the topic, framing, `--template`, limits and the other flags work as usual. The lineup's roles are applied as saved (including no role), the template's roles are not substituted. `--lineup` together with `--participant` is an argument error (code 2); `resume` does not accept the flag.

Before a start by lineup, the positions are checked against the current registry and the provider inspection, and no models are called. The provider is not in `config.json`, it is unavailable, an HTTP provider has no model set, or a scenario is unavailable: the start is rejected before the session is created (code 2) with the list of positions and reasons. The model is not in the provider's current list: a warning, the start goes ahead (as with a manual `--participant`). There is no substitution of provider, model or order; the saved lineup does not change on refusal. Scripted participants (`scripted`) in a lineup work only with `COUNCIL_DEV=1`; in a lineup saved from a `council` command session, they have the scenario file path recorded.

An example on scripted participants (0 model calls):

```bash
export COUNCIL_DEV=1 COUNCIL_HOME=.council-data
npx council --topic "Первая тема" --participant scripted:$PWD/packages/core/scenarios/consensus/p1.json --participant scripted:$PWD/packages/core/scenarios/consensus/p2.json --max-rounds 3
npx council list
npx council lineups save "Ревью" --from-session <id>
npx council lineups
npx council --topic "Вторая тема" --lineup <lineup id> --max-rounds 3
```

Both sessions end with `consensus` (code 0); `lineups save` prints the lineup identifier and a start line, `lineups` shows two positions `scripted:<scenario path>`. Live check through MCP: `COUNCIL_DEV=1 COUNCIL_HOME=<new temporary folder> node packages/mcp/scenarios/lineups/check.ts` (see [docs/mcp.md, "MCP server"](mcp.md#mcp-server)).

In the app. In "Session setup", in the "Participants" block, above the list there is a lineup row: the "Lineup" list (the first item is "Choose…"), the "Lineup name" field and the "Save lineup" button. It saves the provider, model, role and order of the form's current participants under the entered name as a new lineup in `lineups.json`; the topic, framing, materials, limits and defaults do not change, the session does not start, no template is created. A taken name, an empty name and fewer than two participants are refused with a reason at the name field, an existing lineup is not overwritten; a saved lineup cannot be changed or deleted from the app. Choosing a lineup in the list replaces only the participants in the form (with the lineup's roles and order); the topic, materials, limits, ceiling and waiting stay, and the saved entry does not change with edits to the form; the lineup list and the check of positions against the current registry are taken anew at the moment of choosing. An unavailable position (the provider is not in the registry, it is unavailable, the scenario is not found) stays a participant row with the reason, "Start" is unavailable until the owner changes the provider or model of that row or deletes it; there is no substitution of provider, model or order. A model that is not in the provider's current list gets a mark on the row and does not block the start. Before the start, the main process checks the providers again: if a provider became unavailable after the choice, "Start" gives a refusal with a reason and no session is created. If `lineups.json` cannot be read, the "Lineup" list shows the reason, a lineup can be neither chosen nor saved, the file does not change, and the rest of the setup works. Bridge: the `lineups` and `saveLineup` actions; the `startSession` start request carries no lineup identifier.

The lineups stand in the app (0 model calls): the real main modules and the core, scripted participants; it checks the lineup list with the registry check, saving a new lineup and the refusals (a taken name, a damaged file), reading after a "restart", and starting a session by the lineup's positions. English checks: start, lineup position and save refusals in English, return to Russian without recreating the bridge, and the default language. The result is the line `Result: N checks, all passed`.

```bash
COUNCIL_DEV=1 COUNCIL_HOME="$PWD/.council-data-lineups-$(date +%Y%m%d-%H%M%S)" node apps/desktop/scenarios/lineups/check.ts
```

The `--seed-only` mode runs no checks: it prepares a data folder for the app window (a registry without real providers, the lineup "Старый" with the missing provider `local-llm`, the sample file `fx/sample.md`) and prints the `npm run desktop` launch command on that folder.

The stand for participant replacement on resume in the app (0 model calls): the real main modules (bridge, start, resume, markup) and the core, scripted participants, no window; 12 checks: the panel view without and with replacements, refusals for distorted maps and an available participant, "Cancel" without a write, an unavailable participant, two simultaneous resumes, sessions without resume, the mark in the feed. The result is the line `Result: N of M`.

```bash
COUNCIL_DEV=1 COUNCIL_HOME="$PWD/.council-data-replacement-$(date +%Y%m%d-%H%M%S)" node apps/desktop/scenarios/replacement/check.ts
```

The `--seed-only` mode runs no checks: it prepares a data folder for the app window (sessions F1–F6: a recoverable failure, a stopped session with an unavailable participant, sessions without resume, one already resumed with a replacement) and prints the `npm run desktop` launch command on that folder.

## Token ceiling

The number of rounds does not limit spend: long answers and large materials make a round expensive. `--max-tokens <N>` sets the ceiling of total session tokens (input plus output over all turns, an integer of at least 1); `--no-max-tokens` turns off the ceiling set in `config.json` (`defaults.maxTotalTokens`; the initial file does not have it). The ceiling is counted in tokens, not money: not all providers report cost.

- After every turn the command prints the usage: `Usage: spent 500 of 1200 tokens` or `Usage: 500 tokens, no cap`.
- The sum reached the ceiling — the session stops by itself: status `stopped`, reason `token_cap`, in the result `Reason: token cap — spent 1500 of 1200`, the last version and objections are saved, exit code 4. The check runs between turns, a running turn is not cut off, so the spend can exceed the ceiling by one turn.
- Agreement reached on the same turn outweighs the ceiling: the result is `consensus`.
- Turns that did not report tokens are not in the sum; the usage is then marked incomplete, and the ceiling does not trigger on them.
- `council resume <id>` for a session whose spend reached the ceiling requires `--max-tokens` greater than already spent or `--no-max-tokens`; otherwise a refusal with the numbers and code 2. On resume, the ceiling applies to the sum over all segments of the session.

An example on scripted participants (0 model calls; each turn reports 500 tokens): a stop after the third turn, then a resume with a new ceiling.

```bash
COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "Как назвать кота" --participant scripted:packages/core/scenarios/token-cap/p1.json --participant scripted:packages/core/scenarios/token-cap/p2.json --max-rounds 5 --max-tokens 1200
COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council resume <id> --rounds 2 --max-tokens 2500
```

## Independent drafts (experiment)

An optional phase before the regular discussion, off by default. Each participant in turn, in list order, writes their own version of the solution without seeing anything from the others: the draft request holds no participant list, no owner remarks, no questions and no one else's drafts. Then the regular discussion goes on, and all accepted drafts go in full into each of its requests as a separate section, "Independent drafts". An improvement in the quality of solutions is not proven: the check on scripted participants proves isolation, budget and recovery, but not quality. Turn the phase on when you want to compare on your own tasks; a comparison on real models is a separate check that is worth agreeing in advance.

```bash
COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "…" --drafts --synthesizer p2 --participant scripted:<file> --participant scripted:<file> --participant scripted:<file> --max-rounds 2
```

- Flags: `--drafts` turns the phase on; `--synthesizer <pN>` chooses the synthesizer (only together with `--drafts`; by default the first participant, `p1`). An unknown identifier or `--synthesizer` without `--drafts` is code 2, the session is not created.
- What is printed: with `--drafts`, before the first call there is the line `"Independent drafts" experiment: synthesizer p2 «Name», no more than 27 model calls (participants 3 × (rounds 2 + 1) × 3).`; without `--drafts` the start output does not change. An accepted draft is printed as the block `── Draft p1 «Name» · attempts 2 · 123 characters` with the reasoning and text, a failed attempt as the line `✗ Draft …`, the end of the phase as `── Drafts ready: 3 of 3. The synthesizer p2 «Name» starts the regular discussion.`.
- A draft answer is the same JSON, but only `amend` with non-empty `solution` and `reasoning`, no questions and no answers; `files` is allowed once. Any other answer is invalid: a fix request within the remaining calls.
- Call bound: no more than three calls per draft (reading files, a retry, a fix); for a new session `participants × (rounds + 1) × 3` with the phase and `participants × rounds × 3` without it; there is no separate call for synthesis. A participant who has used up three calls on a draft drops out.
- The synthesizer: the first regular turn is made by them and they must give `amend` (version 1); the order of regular turns in all rounds is the participant list shifted to the synthesizer (for p1, p2, p3 and synthesizer p2: p2, p3, p1). Agreement is counted only on regular turns. If the synthesizer dropped out in the phase or on their first regular turn (there is no version 1 yet), the session ends `failed` with the reason `synthesizer_unavailable`: the remaining drafts are not requested, another synthesizer is not chosen, it cannot be resumed — start a new session with a different synthesizer.
- Context limit: the sum of the lengths of the solutions and reasonings of the accepted drafts must fit in `--context-chars` (`contextChars`); there is no truncation. If it does not fit — `failed` with the reason `draft_context_limit`, the discussion does not begin. This is the limit of the drafts section, not of the whole request: materials and file reading have their own bounds, so the request can be longer than `contextChars`.
- The token ceiling is checked after every draft too: reached — `stopped` with the reason `token_cap`; a running draft is not cut off, an excess of one draft is possible. If fewer than two active participants remain, the session ends `failed`, as in a regular discussion.
- Resume: a session interrupted or stopped in the phase resumes from the first unfinished draft, accepted ones are not requested again (see ["Resuming a session"](#resuming-a-session)). A session with a finished phase resumes as usual.
- Snapshots: the text of an accepted draft is in `sessions/<id>/drafts/<draftId>.txt` (`d1` for `p1`, `d2` for `p2`, …), see [docs/data.md, "Data"](data.md#data). Old sessions without the phase are read as before. An app version that does not know the `draft_*` events will not read a session journal with drafts past the first such event, so a version rollback is not promised for sessions started with drafts; sessions without drafts survive a rollback.
- The app turns the phase on, shows it and resumes such sessions, see "Independent drafts in the app" below. For agents the phase is turned on through MCP, see [docs/mcp.md, "MCP server"](mcp.md#mcp-server).
- Check without cost (real `council` and MCP over stdio, scripted participants, 0 model calls; the stand creates and deletes the temporary data folder itself): `COUNCIL_DEV=1 node packages/core/scenarios/independent-drafts/check.ts`.

### Independent drafts in the app

- How to turn it on: in "Session setup", after the "Participants" block, the "Independent drafts" checkbox with the note "Experiment: benefit not confirmed" and an explanation. When it is turned on, a "Synthesizer" list appears from the current lineup, the first participant is selected. The choice follows the participant on reordering; if the selected one was deleted or the lineup was replaced with a named lineup, the first participant is selected. The option is off at every opening of the setup: a repeat of the previous session, a remembered lineup, named lineups and the default settings do not turn it on and do not store it.
- The call bound in the spend estimate is counted by the core's formula: without the phase participants × rounds × 3, with the phase participants × (rounds + 1) × 3. Example: 3 participants, 2 rounds — 18 calls without the phase and 27 with it; when it is turned on, a line with the synthesizer's name is added. The start request carries `drafts.synthesizerId` (`pN` by place in the list); main checks it before the session is created, a synthesizer outside the lineup is a refusal "Invalid launch request: drafts: synthesizerId must name a lineup participant (p1…pN).".
- What is visible on "Discussion": the "Independent drafts" section at the start of the feed — attempt failures and dropouts in the phase, cards of accepted drafts (author, a "draft" badge, size in characters, reasoning, text under the expandable "Draft text" block, without a turn number and version), a "writing a draft" card at the running slot and the line "Discussion started · synthesizer N · name" after the phase. While the phase runs, the header shows "drafts" instead of the round number, and the indicator shows "drafts accepted: k of n". The window requests the texts from main with the `sessionDrafts` action when a session is opened and on every new accepted draft; main reads the `sessions/<id>/drafts/<draftId>.txt` snapshots with a length and `sha256` check, writes nothing and returns an empty list for a session without the phase. A changed or missing snapshot is shown as a "Text unavailable: …" line.
- The phase failures `synthesizer_unavailable` and `draft_context_limit` are explained in words on "Discussion" and "Result" (the synthesizer dropped out without creating version 1; the combined text of the drafts exceeded the context limit).
- "Result": for a session interrupted or stopped in the phase, the "Continue discussion" panel shows the bound as active × rounds × 3 + the remaining calls of unfinished drafts, the caption is supplemented with "+ N for unfinished drafts"; accepted drafts are not requested again.
- The "Result" statistics (duration, tokens, cost) include accepted drafts; the number of turns counts only regular turns.
- Markdown export: the "Discussion log" starts with the drafts section in feed order — the phase heading, attempt failures and dropouts as a list, for each accepted draft the author, reasoning and full text from the verified snapshot (a changed or missing snapshot is a "Text unavailable: …" line, the export is not interrupted), then "Discussion started · synthesizer N · name" and the turns. The file records the reason for a phase failure in words, like "Result".
- A changed or missing draft snapshot leaves a line in the app log: «Draft dN of session <id> not shown: <reason>».
- The benefit of the mode is not confirmed: no comparison with a regular discussion on the same tasks and lineups has been done.
- Check without cost (real main modules, scripted participants `independent-drafts/p1.json`, `p2.json`, `p3.json`, 0 model calls): `COUNCIL_DEV=1 COUNCIL_HOME="$PWD/.council-data/acceptance-41-$(date +%Y%m%d-%H%M%S)" node apps/desktop/scenarios/independent-drafts/check.ts`. The stand checks a start with the phase, a refusal for a synthesizer outside the lineup, the draft texts, resuming an interrupted phase and a damaged snapshot. To see the mode in the development window: `COUNCIL_DEV=1 COUNCIL_HOME=<temporary folder inside the project> npm run desktop`, in "Session setup" choose three "Scripted" participants with the models `independent-drafts/p1.json`, `independent-drafts/p2.json`, `independent-drafts/p3.json` and turn the checkbox on.

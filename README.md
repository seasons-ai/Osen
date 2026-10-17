# Osen

Several models take turns analyzing a problem, editing a shared solution, arguing and asking each other questions until they agree. Launch it from the desktop app with the autumn-style interface, or from Claude Code and Codex through the MCP server and the skill.

- Architecture and protocol: [docs/architecture.md](docs/architecture.md)
- Discussion templates: [docs/templates.md](docs/templates.md)
- Work queue: `openspec list`
- Rules for agents: [AGENTS.md](AGENTS.md)

## Install and check

Node 22.18 or newer is required. There is no build step: Node runs the TypeScript itself.

```bash
npm install
npm run typecheck
npm test
```

## Desktop app

```bash
COUNCIL_HOME=.council-data npm run desktop
```

A window opens on the "History" section: all sessions from the data folder, including those started by the `council` command. The list refreshes by itself; clicking a row opens the session: a running one on the "Discussion" screen, a finished one on the "Result" screen. Above the list there is a case-insensitive substring search over the topic and the template name, and a status filter ("all", "running", "consensus", "no consensus", "stopped", "failed", "interrupted"); they work together and are not saved between launches; when nothing matches, "Nothing found" and "Reset" are shown. A session can be pinned: pinned sessions go in a separate "Pinned" group above the "Others" group, newest to oldest within each group, and pins are kept between launches. There is no way to delete or change sessions from the interface. Pins do not affect `council list` or MCP responses. Above the list there is the "Usage" block (see "Usage in History" below).

The interface fonts are IBM Plex Sans (400, 500, 600) and JetBrains Mono (400, 500) with Cyrillic and Latin glyphs. They are installed by the `@fontsource/ibm-plex-sans` and `@fontsource/jetbrains-mono` packages and ship in the build as `.woff2` files: the window loads them from the app address and does not go to the network for them; `npm run dist:check` verifies all 10 files in `app.asar`. The fonts are licensed under SIL OFL 1.1.

A session written by a newer version of the app (the journal contains an event this version does not know) or with a corrupted journal (a broken or truncated record) is shown in "History" with the badge "newer version needed" or "journal corrupted" instead of a status, with the mark "read up to event No. N"; on the "Discussion" and "Result" screens a message with the same number sits above the content, and only the start of the journal is shown. Resuming, accepting a version, the owner's message and releasing a wait are unavailable for such a session (the reason is given in a tooltip). Stopping, copying and export work; the Markdown export starts with a note line `> …`. What to do: for "newer version needed", update the app, and the session is then read in full; for "journal corrupted", only the start is readable, and the app neither repairs nor changes the journal. Check without cost (0 model calls): `COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the project> node apps/desktop/scenarios/newer-version/check.ts`.

The "New" section starts a discussion from the window: a gallery of templates by category, the cards "Custom topic" and "New template" (templates have the actions "Edit", "Duplicate", "Delete", and a modified built-in one has "Reset to built-in"), then "Session setup" — the topic, materials, participants (provider, model, role, turn order) and the round limit. In the "Participants" block, above the list, there is a row of lineups ("Lineup", "Lineup name", "Save lineup"): choosing one replaces only the participants in the form, and the button saves the current participants as a new lineup; details in "Lineups". The "Save as template" button turns the current setup (topic, roles, round limit, framing) into a new template without starting; providers and models are not included in it — more in [docs/templates.md](docs/templates.md). In the "Materials" block, text files and folders are attached to the topic: with the "Attach files" and "Attach a folder" buttons or by dragging them onto the block. The text of the materials goes to every participant in every turn, so below the list you see the total "N materials · X of Y characters", and the cost estimate includes their size. The collection rules are the same as for `council --attach`: hidden names, `node_modules`, `dist`, `build` and non-text files are skipped (the "Skipped: N" line expands to the reasons); inside a folder, `.env` environment files and unreadable items are skipped too, and an explicitly chosen `.env` is rejected. The limit Y is `defaults.materialsChars` (the "Defaults" tab, initially 60000 characters): when it is exceeded, "Start" is unavailable until some materials are removed; a folder larger than the limit is added partially: descriptions (`.md`, `.markdown`, `.mdx`, `.txt`, `.rst`, `.adoc`) are included, those closer to the root first, and if there are none, the files closest to the root as long as they fit; code is not added, and what is needed is attached as a separate file or subfolder (an explicitly attached file is always included); what did not fit is shown in a collapsed "Not included: N" line with the reasons and a hint, and the selection is recalculated when a row is removed or the limit changes; adding explicit files after which the total would exceed ten times the limit is not accepted at all (a large folder is not affected by this bound). Attached items are reset after launch, on "Back to templates" and when leaving the setup screen: a new session setup always starts without materials; the texts of the materials are shown only in the preview. The "Materials preview" action in the "Materials" block starts nothing and shows the exact text of the "Owner's materials" section (what will go into every request), the folder table of contents and the full list of its files marked "in the initial context" and "available on request", as well as the reasons for skips. "Accept set" binds "Start" to the shown set: the session gets exactly these texts, and changing or deleting a file on disk after the preview does not change the accepted set. Changing the set of materials or the limit withdraws the acceptance ("The preview is outdated"), and "Start" runs the session on the current set; "Refresh" rereads the files from disk and prepares a new set (if a file could not be read, the reason and the previous set remain). An accepted set is valid for 24 hours. From an attached folder, the descriptions within the limit go into the request, and its other files are saved as a snapshot in the session, and the participants read them on request if the topic needs it (no more than 5 files and 40000 characters per turn); the screen shows the line "Folder: F files, N characters — …", and the feed shows the line "read: …" with the file names under the turn text. The "Token cap per session" field is optional: it holds the default value from settings, an empty field means a session without a cap, and anything other than an integer of 1 or more is rejected. Before the start you can see the upper bound on the number of model calls (participants × rounds × 3), the token cap ("cap N tokens" or "no cap") and marks for participants that use a subscription or are billed. "Start" creates the session and opens the "Discussion" screen; the lineup of the last session started from the app is offered next time. The setup screen can also be opened from a past session ("Run again", "Discuss further" on the "Result" screen) — see docs/architecture.md.

Excluded by `.gitignore` rules in "Session setup". If the attached folder has a `.gitignore`, the "Materials" block shows, next to "Skipped" and "Not included", an expandable line "Excluded by rules: N": each row has the path (`proj/out/` — the whole folder), the rule and a "Return" button. After a return the row is marked "returned" and has an "Exclude again" button, and the "Folder" line grows by the files of that path: they enter the session's folder snapshot and the list for reading on request, and the initial set by the general selection rules under the limit. The same section is in the "Materials preview" window (after a return or "Exclude again" the preview goes stale: "Refresh", then "Accept set"). A return lives in the current setup: it is reset by "Clear" and by the start of a new setup, and it is not carried over to "Run again" and "Discuss further". There is no global "no rules" switch in the window; the terminal `--no-ignore` stays only in `council`.

The "Settings" section, "Providers" tab: a card for every provider in the registry — whether the CLI was found (version, path), the endpoint address, the name of the key variable and the "key set / key not set" flag, and the reason for unavailability in words. Key values are not entered or shown in the app: the value is written into the `.env` file of the data folder, and "Check again" rereads it without a restart. An HTTP provider is added, edited and deleted from the window (a deleted one is also removed from the default participants; past sessions with it stay in history). Each provider shows its list of models and the source of the list; "Refresh models" requests the list again, and a model can be added manually — then the list is stored in `config.json` and replaces the received one, and "Restore the provider's list" undoes that. "Test" makes one real model call and only after a confirmation that names the model and says the call is billed or uses a subscription; the model is chosen in the confirmation. The "Defaults" tab: round limit, turn timeout, context size, materials size (the character limit of attached files per session), token cap per session (empty — no cap; the value is applied to a new session setup without a restart), the upper bound on the number of participants and the lineup of participants for new sessions. Changes are written to `config.json` only after validation; if the write fails, the previous file stays as it was. The app does not repair a file with an error: the screen shows the field, the reason and the path. The screen is shown in the selected language; the labels in this paragraph are the values of the `en` language.

The "Discussion" screen: on the left, the participants with their state (waiting for turn, thinking, agrees, objects, dropped), the "k of n agreed" indicator, the number of open questions and, if materials are attached to the session, a "materials: N" line that expands to names and sizes; under the agreement indicator is the token usage: for a session with a cap, "X of Y tokens" with a bar (a warning icon from 80% of the cap), for a session without a cap, "X tokens spent" if the participants report tokens; "incomplete count" means that some turns did not report tokens. When usage reaches the cap, the session stops by itself: the badge "stopped · token cap" and a message with the numbers at the end of the feed; in the center, the feed of turns with question-and-answer pairs, failures and dropouts; on the right, the current solution with version switching. "Show changes" compares the selected version with the previous one word by word: additions are marked with "+" and underlining, removals with "−" and strikethrough, and above the text are the version author and the number of added and removed words; the first version has no comparison. If either of the two texts is longer than 2000 words or 20000 characters, lines are compared: the common start and end stay, the middle is marked as replaced as a whole, and the counters refer to whole changed lines. "Copy" in this panel puts the clean text of the selected version on the clipboard, without comparison marks. For a session started in the app, the text of the turn being prepared appears as the model responds; a session from the terminal updates on completed turns. "Stop" asks for confirmation and stops both its own session and one started by the `council` command. If you scroll the feed up, it does not jump to new turns but shows a "new turns: N" button. Under the feed of a running session is the "Owner's message" field: the message is queued in the session the same way as `council say`, is shown in the feed with the label "waits for the turn to end" until the end of the current turn, then becomes an "Owner" entry; after it all participants confirm their agreement again. Participants' questions to the owner are marked in the feed "question for the owner" and collected above the field in the "Questions for you" block: "Answer" sends the answer as a message linked to the question; a question not answered within a round is labeled "closed without answer". If the message cannot be accepted (the session has ended, the executor is not running, the question is already closed), the reason is shown and the text stays in the field. The field also works for sessions started from the terminal or by an agent; for a finished session, messages and questions are visible in the feed read-only.

The "Result" screen opens by itself when the session has finished: the status, the final solution, those who agree, those who object with their latest argument, those who dropped out, and statistics (rounds, turns, duration; tokens and cost only if the participants reported them, incomplete data is marked). "Copy result" puts the text of the final version on the clipboard and confirms "Version N (discussion result) copied to the clipboard", "Export to Markdown" saves to a chosen place a file with the topic, participants, materials (names and sizes, without texts), status, solution, objections and all turns, including the owner's messages and questions to the owner, and "To the feed" returns to the turns. "Run again" opens "Session setup" filled in from this session: topic, participants with providers, models and roles, round limit and materials — everything can be edited before "Start". "Discuss further" does the same and adds a material with the text of one version (it counts toward the overall materials limit): if you accepted a version in the "Owner's choice" block (including before the discussion was resumed), it is the chosen version under the name "Owner's choice: version N of the previous session YYYY-MM-DD", otherwise the final version shown on "Result", under the name "Solution of the previous session: version N, YYYY-MM-DD"; the action is unavailable if the session has no solution version at all. The materials of a rerun are taken from the snapshots of the previous session, not from disk: the source files may already be deleted; a corrupted or missing snapshot is not carried over, and the reason is shown in the "Materials" block. The discussion framing is taken from the previous session even if the template has since been changed or deleted — then the screen shows the label "framing from the previous session". A participant whose provider is no longer available stays in the list with a mark: replace it or remove it. The previous session does not change, and the new one gets its own identifier. The labels of the "Result" screen, the "Resume discussion" panel and the export file are shown in the selected language; in the export file the labels are in the language at the moment of export, while the texts of the discussion (topic, solution, arguments, dropout reasons) stay as recorded; the fallback file name is `discussion.md` / `обсуждение.md`.

The completed session's "Result" has an "Owner's choice" block: choose one of the existing solution versions, add a note if you wish, and press "Accept version". This is your own separate record, not the models' agreement: the session status ("no consensus", "stopped" and so on), the final solution and the objections stay as they were, no models are called, and there is no usage. The chosen text is shown in the same block together with the note, the time and the status at the moment of the choice; the "Copy choice" button puts it on the clipboard with the confirmation "Version N (your choice) copied to the clipboard", while "Copy result" still copies the final version. The chosen text goes into "Export to Markdown", `council show` and the `council_status` response. The choice can be changed — earlier ones stay in the session journal. The action is unavailable while the session has no result (it is running or interrupted) or has no solution version at all. A choice can be recorded only in the app; the terminal and MCP show it. An app of version 0.3.0 or earlier reads the journal of such a session only up to the choice event.

A session with the status "no consensus", "stopped" or "interrupted" has a "Continue discussion" button on the "Result" screen, and so does "failed" if the session ended because fewer than two active participants were left ("consensus reached" and the other failures have no button); it works for sessions from any source: app, terminal, MCP. The button opens a panel with the "More rounds" field (from 1 to 20; by default the remainder of the previous limit, otherwise the default from settings), the upper bound on the number of model calls (active participants × rounds × 3) and marks for participants that use a subscription or are billed. "Continue" is consent to these calls, and "Cancel" changes nothing. If there is someone to replace (a participant who dropped out — optionally, an active one whose provider is currently unavailable — necessarily), the panel has a "Participant replacement" section: each row has a "Replace" button that opens provider and model lists from the same catalog as in "Session setup" (scripted models only from the catalog, a path from the window is not accepted), and "Keep" clears the choice. After each choice the panel recalculates: the future lineup (a new participant gets the next identifier, the place and role of the previous one, and a name by the rule of the "Session setup" form; in the list it is marked "pN · instead of pM “Name”"), the upper bound on calls, the warning "After a replacement all agreements are reset: every active participant confirms the current version again" and "N tokens spent". Without a replacement it is impossible to continue, and the panel shows the reason from the engine and "Continue" is unavailable. A replacement of an available participant is rejected. Rejections are shown on the panel, and the choice of replacements is kept: the provider of an active participant is unavailable ("Continue" is unavailable, the participant and the reason are named), the session is running in another process, the material snapshot is missing or changed. If the session's usage has already reached the token cap, the panel shows the cap and the amount spent and asks you to choose: enter a "New cap" above the amount spent or check "Remove the cap" — until then "Continue" is unavailable; if the cap is not exhausted, it stays the same and is not shown on the panel. A session stopped by the cap is labeled "stopped · token cap" on "Result" and in "History" — separately from a stop by the owner. After confirmation the "Discussion" screen of the same session opens: in the feed there is a "Resumed" divider with the number of added rounds and the date, turn numbering continues, and in "History" the session is "running" again. After a replacement, under the divider there are lines "Replaced: old → new · dropped out: reason" (or "was unavailable") and "Agreements reset: participants confirm the version again", questions to the replaced participant are marked "closed: participant replaced", the participants panel shows the active ones ("replaced pN “Name”"), earlier turns stay with their earlier author; on "Result" and in "Export to Markdown" the replaced one is named "replaced by participant pN “Name”". If unapplied owner message requests were removed on resuming, their number and texts are shown above the feed. The app becomes the executor, so closing the window during such a session requires confirmation. What carries over, how an unfinished turn is repeated and how rounds are counted are the same rules as for `council resume`: see "Resuming a session".

- An unavailable provider is shown in the list with the reason, and starting with it is closed.
- Scripted participants (free check) appear in the provider list only with `COUNCIL_DEV=1`: `COUNCIL_DEV=1 COUNCIL_HOME=.council-data npm run desktop`. Scenarios are files from `packages/core/scenarios/`; to check messages and questions to the owner from the window, there are scenarios with a turn delay `owner-dialog/p1.json`, `p2.json` (message) and `owner-dialog/ask-p1.json`, `ask-p2.json` (question to the owner); to check the token cap, `token-cap/slow/p1.json`, `p2.json` (500 tokens per turn, a turn lasts 3 seconds, the second participant always objects).
- The session runs in the app process and continues when you go to another section. Closing the window or quitting while a session is running requires confirmation; after it the session stays in "History" with the status "interrupted".
- The app announces the end of a discussion with a macOS system notification: status, topic and number of rounds. This also applies to sessions from the terminal and MCP if the app was open while they ran; there are no notifications for sessions that finished before the app launched. There is also no notification when the window is in the foreground and this same session is open. Clicking the notification opens the session's "Result". The app has no switch — notifications are turned off in macOS: "System Settings" → "Notifications" → `Osen` (when launched from source — `Electron`).
- When a running discussion needs the owner, the app also notifies with a system notification: "Question for the owner" — a participant asked you a question, "The discussion is waiting for the owner" — a pause after a round has occurred. One question and the answer wait it causes produce one notification, and each new pause its own; there are no notifications for questions and pauses recorded before the app launched. The notification has no topic or question text — only a request to open the discussion. Clicking opens the "Discussion" of that session, or, if it has finished in the meantime, its "Result". When the window is in the foreground and this same session is open, there is no notification. The texts of the notifications (about a question, about a pause and about completion) are in the interface language in effect at the time of display: in English "Question for the owner", "The discussion is waiting for the owner"; the topic is shown as recorded. These notifications are turned off in the same place, in the macOS settings.

- Without `COUNCIL_HOME` the app works with the owner's data folder (see "Data"), as does the `council` command.
- The first launch downloads Electron (about 100 MB); later ones start immediately.
- A repeated launch does not open a second window but returns focus to the one already open.
- The interface is isolated: it reaches files, keys and the environment only through the declared bridge actions (`apps/desktop/src/shared/bridge.ts`). Errors are shown in the window and written to `logs/app.log`.
- Build without launching: `npm run build -w @model-council/desktop`.
- macOS installer image: `npm run dist`; check the contents: `npm run dist:check`; install, update and rollback: [docs/deploy.md](docs/deploy.md).

Waiting for the owner in the window. "Session setup" has a "Waiting for the owner" block with two checkboxes, both off by default: "Pause after a round" (after each round without a result the discussion waits for you) and "Wait for the owner’s reply" (the next turn does not start until you answer a participant's question). When either is on, the "Wait time, sec" field appears — an integer from 1 to 86400, initially 300; when the time runs out, the discussion continues by itself, and unanswered questions stay unanswered. An invalid time blocks "Start". The settings are saved in the session, and "Run again" fills them in; in old sessions the checkboxes are off.

While the discussion waits, the "Discussion" screen shows a "Waiting for the owner" panel above the message field: the reasons, how much time is left and three actions. "Continue" releases the wait — models are called only after that. "Add a message" puts the cursor in the message field; the message itself does not resume the discussion. "End" stops the discussion after confirmation. An answer to a question is given as before, through "Questions for you": it releases only its own question, and the round pause stays until "Continue" or the end of the time limit. An expired time limit is visible in the feed as the line "Wait time expired". If the discussion process closed during the wait, "Result" shows "Discussion interrupted" and a note about the earlier reasons and the time limit; "Continue discussion" will wait until the same time limit.

### Usage in History

On the "History" screen, above the list, is the "Usage" block: input and output tokens and cost in USD that providers reported (the "Reported by provider, USD" column) and, when tariffs are set, a separate "Tariff estimate" column, for the chosen period, by provider and with a "Total" row, with a records-count column.

- Period: "Today", "Month" (the current calendar month) or a "Range" of two dates. Days are counted in Moscow time (Europe/Moscow) regardless of the computer's time zone, and both dates of a range are inclusive. If the start is later than the end, the summary is not calculated and the reason is shown. The period is kept when the list auto-refreshes and when leaving the screen; restarting the app resets it.
- The summary always covers the whole history for the period: the topic search and the status filter narrow only the list, and this is labeled "all history for the period".
- The group is the provider identifier recorded in the session itself (for a replacement participant, in the resume record); a provider deleted from settings stays as its own row.
- "unknown" — nobody reported the value (this is not zero); `0` — the provider reported zero; "incomplete: missing in N of M" — the sum is built only from records where the value exists. A missing half of the token breakdown is not filled in with zero.
- A turn with retries is counted once, by the total usage of the completed turn (including calls to read files and failed attempts inside it), and belongs entirely to the completion time; an independent draft likewise. For a turn or draft without completion, only the failures that reported usage are counted; a call of such a turn after which the journal has neither a result nor a failure (for example, a request for folder files) goes into the warning about calls without outcome. A nonzero cost below $0.0001 is shown as "< 0.0001 $".
- Warnings: calls without outcome (started, but the journal has neither a result nor a failure, usage may have occurred but is not recorded); logs that could not be read, and logs read only partially (they are counted over the whole history, not the period); records with an undetermined provider (calls of different providers in one record, or a participant outside the session lineup) — their sum is in a separate "provider not determined" row, attributed to no one.
- This is not a provider invoice: the summary contains only what providers reported and what is recorded in the logs; actual usage may be higher. The summary only reads the logs: choosing a period and refreshing write and recalculate nothing.
- Screen language: the labels of "History" and the "Usage" block, numbers, money and dates are shown in the interface language (see "Interface language"). In English — "1,000,000", "0.5 EUR", "< 0.0001 $", "today, 2:05 PM", "October 2026"; in Russian — «1 000 000», «0,5 EUR», «< 0,0001 $», «сегодня, 14:05», «октябрь 2026». Search is case-insensitive under the rules of the selected language; a session without a template is searched by the label shown in that language ("Custom topic" or «Своя тема»). Session topics, the owner's template names, the texts of tariff warnings and the reasons for skipping logs from the core are not translated. Period days are counted in Moscow time in any language: changing the language does not change which records fall into the period.

#### Cost estimate by tariff

Some providers report tokens but not cost. To see the order of magnitude of usage, you can set prices in a file, and "History" will calculate an estimate next to the reported cost.

- The `tariffs.json` file is optional and lives in the data folder next to `config.json` (path: `npx council home`). Only you create and edit it, by hand: the app does not create, change or "fix" the file, does not request prices from the network, and has no edit form.
- Example:

```json
{ "tariffs": [
  { "providerId": "local-llm", "model": "qwen3-coder", "source": "https://example.test/pricing",
    "asOf": "2026-10-09", "currency": "USD", "inputPerMillion": 2, "outputPerMillion": 4 }
] }
```

- Entry fields (all required, no others allowed):
  - `providerId` — the provider identifier, as in the session; `model` — the exact model name; the comparison is exact and case-sensitive;
  - `source` — where the price comes from: non-empty text or an address, up to 500 characters;
  - `asOf` — the price date, `YYYY-MM-DD`, an existing calendar date;
  - `currency` — three uppercase Latin letters (`USD`, `EUR`);
  - `inputPerMillion`, `outputPerMillion` — the price per million input and output tokens, a finite number not less than 0.
- Calculation for one usage record: `input tokens × inputPerMillion / 1,000,000 + output tokens × outputPerMillion / 1,000,000`. Example: 1,000,000 input and 500,000 output tokens at prices of 2 and 4 USD give 4 USD. The usage record is the same as in the summary of reported usage, so repeats are not counted twice. The result is not rounded; rounding happens only on display.
- A record is estimated only if everything holds: the record's provider and model are determined (the model is taken from the participant lineup in the session journal, including when a participant was replaced on resuming; a record that includes calls of participants with different providers or models, and a participant outside the lineup, are not estimated); the model is not `default` (for a CLI participant this is "default model", the actual model is unknown, even if a tariff for `default` is written); there is an applicable tariff for the provider/model pair; both input and output tokens are reported (a reported zero qualifies, a missing half is not filled in with zero).
- On screen: next to the "Reported by provider, USD" column is the "Tariff estimate" column. Sums for each currency go on a separate line ("4 USD", "0.5 EUR"), currencies are not converted or added together, and there is no overall money sum. With partial coverage, "estimated k of n" is shown; if no record is estimated, "unknown". Records not estimated are listed in the block's warning with the number of records by reason: "record model not determined", "model “default”, the actual one is unknown", "no tariff for the model", "no input or output tokens". Under the table is the "Estimate tariffs" list: provider and model, prices, source and price date of each tariff by which at least one record of the period was estimated. The estimate does not replace the reported cost and is not written to the logs.
- File states:
  - no file — no estimate column, under the table the line "The tariff estimate is unknown: tariffs are not set (the tariffs.json file in the data folder).", no warnings;
  - the file is unreadable, not JSON, or not an object with a `tariffs` array — no record is estimated and there is one warning: `tariffs.json: not JSON`, `tariffs.json: an object with a tariffs field holding an array of entries is expected` or `tariffs.json: could not read (<code>)`;
  - an invalid entry (including one with an unknown field, for example a cache price) is not applied, with the warning `tariffs.json: entry N is not applied — <field>: <reason>`, and the other entries are applied;
  - if two or more entries have the same `providerId`/`model` pair, none of them is applied, with the warning `tariffs.json: entries 1 and 3 are not applied — duplicate pair local-llm / qwen3-coder`.

  The summary of reported usage works as before in all these cases. The app writes every new tariff warning as a line to `logs/app.log`.
- What the estimate is not: it is a calculation at the current tariff from the file, not an invoice and not a confirmation of past charges. The price applies to all records of the period regardless of the record date; cache, batch and other discounts are not accounted for; there is no money cap on a session. The estimate is shown only by the app; in the terminal (`council`) and in the MCP server it does not exist.
- A new price: edit `tariffs.json`. The new estimate, source and date appear at the next refresh of the summary (changing the period, auto-refresh of the list, re-entering the screen); the logs and the reported cost do not change.

## The `council` command

Runs a discussion from the terminal: participants take turns editing a shared decision until they agree, and the progress is printed as it goes. Participants are `claude` and `codex` (installed CLIs, see README, "CLI participants"), models behind an HTTP endpoint (see README, "HTTP participants") and scripted `scripted` participants.

```bash
COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "Как назвать кота" --participant scripted:packages/core/scenarios/consensus/p1.json --participant scripted:packages/core/scenarios/consensus/p2.json --max-rounds 3
```

Expected: three turns, versions 1 and 2, the line `══ Outcome: consensus` and exit code 0.

- Participant: `--participant [name=]<provider>[:<model>]`, the flag is repeated, the order sets the queue, at least two are required. The provider is an identifier from `config.json` (`claude`, `codex`) or `scripted:<scenario file>`; if no model is given, the CLI's default model is used. Examples: `claude`, `codex:<model>`, `Ann=claude:haiku`. The default name is the provider name (with the model, if one is given), and for `scripted` it is `Participant N`. Without `--participant`, the default participants from `config.json` are used.
- Required flag: `--topic`. Optional: `--template`, `--max-rounds`, `--turn-timeout` (seconds, an integer from 1 to 2147483), `--context-chars` (by default from the template, otherwise from `config.json`), `--attach`, `--include`, `--no-ignore`, `--url`, `--preview-materials`, `--prepared-materials` and `--materials-chars` (see README, "Materials"), `--framing` (by default the template's framing, without a template a neutral one), `--drafts` and `--synthesizer <pN>` (see README, "Independent drafts (experiment)"). Full help: `npx council --help`.
- Turn context and `--context-chars`. The limit trims only the turn log: in a long session the earliest turns drop out of the request with the note «[Early turns omitted due to the context limit: N]». The limit does not trim the "Positions on the current version" section: for each active participant it contains «agrees», «objects (turn N)» with the verbatim arguments of the latest objection to the current version, or «no current position on version N». An objection longer than 2000 characters is shown as its first 2000 with the note «[showing the first 2000 of M characters, turn N]». With participant names up to 40 characters, the section adds no more than 6700 characters to the request with 3 participants and no more than 17450 with 8 (all of them objecting with text of 2000 characters or more; long names add their length for each participant); a line for an agreeing participant is a few dozen characters, for an objecting one it is the length of their arguments. A turn "agree with questions" that was counted as an objection is marked in the section the same way as in the log. In the record of a participant's answer shown to a participant, the text of the question (up to 500 characters, with the same note) stands next to the answer, so the answer is clear even when the turn with the question has been dropped; this record counts toward the log limit. In an English session the section is called "Positions on the current version".
- Lineups: `--lineup <id>` takes participants from a saved lineup instead of `--participant` (together they give code 2); `council lineups` and `council lineups save <name> --from-session <id>` list and save lineups. Description: README, "Lineups".
- `scripted` works only with `COUNCIL_DEV=1`; the variable is taken from the process environment or from `.env` (the data folder first, then the current folder).
- A scenario is JSON `{ "steps": [...] }`; a step is one of four kinds: `{ "response": {...} }`, `{ "raw": "text" }`, `{ "error": "message" }`, `{ "timeout": true }`; any step can set `delayMs` and `expectPrompt` (text that must be in the request to the participant, otherwise the call fails without retries). Ready-made examples: `packages/core/scenarios/`.
- `Ctrl+C` stops the session with the status `stopped`; `council stop <id>` from another terminal does the same; `council say <id> <text>` sends the owner's message to a running session (see README, "Owner's message"), `council say <id> --answer <qN> <text>` answers a participant's question to the owner (see README, "Questions to the owner"); `council resume <id>` continues an interrupted, stopped or no-consensus session (see README, "Resuming a session").
- A real run spends Claude and Codex subscriptions: up to `participants × rounds × 3` calls. Run it only deliberately:

```bash
COUNCIL_HOME=.council-data npx council --topic "Как назвать кота" --participant claude:haiku --participant codex --max-rounds 2
```

- Provider state (no model is called):

```bash
COUNCIL_HOME=.council-data npx council providers
```

  An HTTP provider has a different block: `id  openai-http  available | unavailable: reason  address`, a `key:` line and a `models:` line without `default` (see README, "HTTP participants"). A CLI provider gets one block per provider: `id  cli  available | unavailable: reason  version  path`, then a warning (if any), a `models:` line (always starting with `default`) and, if the model list is not confirmed, the reason. If the registry is empty, the line «No providers: …» is printed.
- Discussion templates (no model is called):

```bash
COUNCIL_HOME=.council-data npx council templates
```

```bash
COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "Переписать модуль отчётов с нуля или чинить по частям" --template refactoring-plan --participant scripted:packages/core/scenarios/consensus/p1.json --participant scripted:packages/core/scenarios/consensus/p2.json
```

  The first command prints one line per template: `identifier  category  title  source`. After the line `Topic: …`, the second prints `Template: refactoring-plan` and ends with the line `══ Outcome: consensus`. The file format and error breakdown: [docs/templates.md](docs/templates.md).
- Subcommands (each saves and reads sessions from the data folder, see README, "Data"):

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

`list` prints one line per session, newest first: `id  date  status  source  start of the topic`; `show <id>` prints the turns and state of the session, and if the owner accepted a version in the app, a separate «Owner's choice» block with the version number and text, the note, the time and the outcome at the moment of the choice (the status and the discussion result are printed as before; the choice is not called agreement); `status <id>` is brief: status, round, number of turns and the current owner wait with its reasons, questions and deadline; `continue <id>` releases the current owner wait of a running session (see README, "Waiting for the owner"); `stop <id>` requests a stop of a running session; `say <id> <text>` sends the owner's message to a running session (`say <id> --answer <qN> <text>` answers a participant's question); `home` prints the data folder path (it does not create the folder).

When a journal was not read in full, `list`, `status` and `show` mark it after the status: «the journal was written by a newer version, read up to event No. N» (the line is intact but unknown to this app version: a newer version appended to the journal) or «the journal is corrupted, read up to event No. N» (a broken or truncated record). For a session of a newer version with no recorded result, instead of «running» and «interrupted» they print `state undetermined · the journal was written by a newer version, read up to event No. 3`, and `status` and `show` add the line «Update the app to read the whole session.» (`list` prints it after the list). If the result was recorded before the unreadable line, it is printed with the same mark, for example `consensus · the journal was written by a newer version, read up to event No. 7`. `resume`, `say` and `continue` reject such a session with code 2 and a message about the newer version (the journal does not change); `stop` is accepted while the executor is running. Check without cost (0 model calls, real `council` and MCP processes over stdio, scripted participants):

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
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

### Owner's message

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

### Questions to the owner

A participant can ask the owner about something the participants cannot decide themselves (missing facts, preferences). In the output of a running discussion the question stands in the turn line, with a hint; in `council show` it is the same line without the hint:

```
Question to the owner · q1 · p1 «Participant 1»: В каком формате нужен отчёт: таблица или текст?
  answer: council say <id> --answer q1 "<text>"
```

The answer is an owner's message tied to the question: `council say <id> --answer <qN> <text>`. On success the command prints `Answer to question qN for session <id> requested: participants will see it from the next turn.` and returns 0; the running turn is not interrupted. The answer, like any message, resets those who agreed, and the question is closed as answered. In the output it looks like this: `── Owner · o1 · after turn 2 · answer to q1`, with the text below.

Without the `--wait-for-owner` flag (see README, "Waiting for the owner") the discussion does not wait for an answer. If there is no answer by the next turn of the participant who asked, the question is closed unanswered (in the output, the line `  question q1 was left unanswered`), the list of agreeing participants is reset, and the participants decide on their own. An open question to the owner, like any open question, prevents consensus.

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

### Waiting for the owner

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

In the app the wait is turned on in "Session setup" and controlled by the "Waiting for the owner" panel on the discussion screen — see README, "Desktop app". The panel also controls a session started by the `council` command with the same data folder. The MCP server turns the wait on at start (`council_start`), shows it (`council_status`) and releases it (`council_continue`), see README, "MCP server". App versions built before the wait appeared (0.4.0 and earlier) read the journal of such a session only up to the first wait event.

### Resuming a session

`council resume <id> [--rounds <n>] [--max-tokens <n> | --no-max-tokens] [--replace <pN>=<entry>]…` continues a saved session with the status `interrupted`, `no_consensus` or `stopped` (or `failed` after the "fewer than two active participants" failure, see below) from the same place and under the same identifier: there is no new session, a `session_resumed` event is added to the journal, and turn and round numbers continue. The topic, framing, template and limits do not change; the lineup changes only with the `--replace` flag, so the command does not accept the other launch flags (`--topic`, `--participant`, `--max-rounds` and so on): code 2 with help.

`--rounds` is how many more rounds to run, counting the unfinished one. Without the flag, the remainder of the previous limit is used. Example: limit 4, one round fully completed — `resume <id>` runs 3 more rounds, `resume <id> --rounds 2` runs 2 rounds (the new total limit is 3). Before the first call the command prints `Continuation of session <id>: <n> more rounds (total limit <m>), no more than <k> model calls (active participants <a> × <n> × 3).`; dropped-out participants are not counted.

Carried over: the current version, agreeing participants, questions and answers, dropped-out participants, owner messages, materials (taken from the session snapshots, the source files are not needed). An interrupted turn is repeated from the beginning. Messages queued with `council say` but never applied (the executor was killed) are deleted: the command prints their number and texts, so send them again.

If the session was interrupted or stopped in the independent drafts phase (see README, "Independent drafts (experiment)"), it resumes from the first unfinished draft, and the call bound in the plan line includes the remaining draft calls; the command names it separately.

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

### Lineups

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
cd "/Users/korat/Desktop/Мозговой штурм"
export COUNCIL_DEV=1 COUNCIL_HOME=.council-data
npx council --topic "Первая тема" --participant scripted:$PWD/packages/core/scenarios/consensus/p1.json --participant scripted:$PWD/packages/core/scenarios/consensus/p2.json --max-rounds 3
npx council list
npx council lineups save "Ревью" --from-session <id>
npx council lineups
npx council --topic "Вторая тема" --lineup <lineup id> --max-rounds 3
```

Both sessions end with `consensus` (code 0); `lineups save` prints the lineup identifier and a start line, `lineups` shows two positions `scripted:<scenario path>`. Live check through MCP: `COUNCIL_DEV=1 COUNCIL_HOME=<new temporary folder> node packages/mcp/scenarios/lineups/check.ts` (see README, "MCP server").

In the app. In "Session setup", in the "Participants" block, above the list there is a lineup row: the "Lineup" list (the first item is "Choose…"), the "Lineup name" field and the "Save lineup" button. It saves the provider, model, role and order of the form's current participants under the entered name as a new lineup in `lineups.json`; the topic, framing, materials, limits and defaults do not change, the session does not start, no template is created. A taken name, an empty name and fewer than two participants are refused with a reason at the name field, an existing lineup is not overwritten; a saved lineup cannot be changed or deleted from the app. Choosing a lineup in the list replaces only the participants in the form (with the lineup's roles and order); the topic, materials, limits, ceiling and waiting stay, and the saved entry does not change with edits to the form; the lineup list and the check of positions against the current registry are taken anew at the moment of choosing. An unavailable position (the provider is not in the registry, it is unavailable, the scenario is not found) stays a participant row with the reason, "Start" is unavailable until the owner changes the provider or model of that row or deletes it; there is no substitution of provider, model or order. A model that is not in the provider's current list gets a mark on the row and does not block the start. Before the start, the main process checks the providers again: if a provider became unavailable after the choice, "Start" gives a refusal with a reason and no session is created. If `lineups.json` cannot be read, the "Lineup" list shows the reason, a lineup can be neither chosen nor saved, the file does not change, and the rest of the setup works. Bridge: the `lineups` and `saveLineup` actions; the `startSession` start request carries no lineup identifier.

The lineups stand in the app (0 model calls): the real main modules and the core, scripted participants; it checks the lineup list with the registry check, saving a new lineup and the refusals (a taken name, a damaged file), reading after a "restart", and starting a session by the lineup's positions. English checks: start, lineup position and save refusals in English, return to Russian without recreating the bridge, and the default language. The result is the line `Result: N checks, all passed`.

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
COUNCIL_DEV=1 COUNCIL_HOME="$PWD/.council-data-lineups-$(date +%Y%m%d-%H%M%S)" node apps/desktop/scenarios/lineups/check.ts
```

The `--seed-only` mode runs no checks: it prepares a data folder for the app window (a registry without real providers, the lineup "Старый" with the missing provider `local-llm`, the sample file `fx/sample.md`) and prints the `npm run desktop` launch command on that folder.

The stand for participant replacement on resume in the app (0 model calls): the real main modules (bridge, start, resume, markup) and the core, scripted participants, no window; 12 checks: the panel view without and with replacements, refusals for distorted maps and an available participant, "Cancel" without a write, an unavailable participant, two simultaneous resumes, sessions without resume, the mark in the feed. The result is the line `Result: N of M`.

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
COUNCIL_DEV=1 COUNCIL_HOME="$PWD/.council-data-replacement-$(date +%Y%m%d-%H%M%S)" node apps/desktop/scenarios/replacement/check.ts
```

The `--seed-only` mode runs no checks: it prepares a data folder for the app window (sessions F1–F6: a recoverable failure, a stopped session with an unavailable participant, sessions without resume, one already resumed with a replacement) and prints the `npm run desktop` launch command on that folder.

### Token ceiling

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

### Independent drafts (experiment)

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
- Resume: a session interrupted or stopped in the phase resumes from the first unfinished draft, accepted ones are not requested again (see README, "Resuming a session"). A session with a finished phase resumes as usual.
- Snapshots: the text of an accepted draft is in `sessions/<id>/drafts/<draftId>.txt` (`d1` for `p1`, `d2` for `p2`, …), see README, "Data". Old sessions without the phase are read as before. An app version that does not know the `draft_*` events will not read a session journal with drafts past the first such event, so a version rollback is not promised for sessions started with drafts; sessions without drafts survive a rollback.
- The app turns the phase on, shows it and resumes such sessions, see "Independent drafts in the app" below. For agents the phase is turned on through MCP, see README, "MCP server".
- Check without cost (real `council` and MCP over stdio, scripted participants, 0 model calls; the stand creates and deletes the temporary data folder itself): `COUNCIL_DEV=1 node packages/core/scenarios/independent-drafts/check.ts`.

#### Independent drafts in the app

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

### Materials

`--attach <path>` attaches a file or folder to the discussion; the flag repeats. The engine reads the materials once before the start, their full text goes into the request of every turn; the participants have no tools and no disk access, the engine serves them the folder files they need from the snapshot on request. `--attach` of a folder saves a snapshot of the whole folder in `sessions/<id>/workspace/` before `session_created` (in the event `session.workspace = { files, chars }`), like the app; a folder larger than the limit is not rejected, a bounded initial set goes into the requests. Text snapshots are stored in `sessions/<id>/materials/`, and the journal holds only names, sizes and checksums.

```bash
COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "Что улучшить в формате шаблонов" --attach docs/templates.md --participant scripted:packages/core/scenarios/consensus/p1.json --participant scripted:packages/core/scenarios/consensus/p2.json --max-rounds 3
```

Before the start, ahead of the `Session …` line, a summary is printed: `Materials: <number>, size <characters> characters (limit <N>).`; if anything is skipped — `Skipped: <n>` and a line `  <name> — <reason>` for each. If the folder yielded at least one file, before them is printed `Folder snapshot: files <n>, size <characters> characters (bound 20000000).`; if anything did not make it into the initial set — `Not in the initial set: <n> (participants read on request)` and up to 20 lines `  <name> — <reason>` (then `  … and <k> more`). If links are given, `Link sources: <n>` is added and a line per link `  m2 ← https://example.com/docs/page.html · fetched <ISO time>`. The texts of the materials are not printed. An empty folder is not an error: `Materials: 0, size 0 characters …`, the discussion goes on without materials. The example above makes no model calls.

A link in the app: in the "Materials" block, the "Link" field and the "Add link" button accept an address with the same restrictions as `--url` (only public `http`/`https`, the core's limits). The main process downloads it, the window receives only the list view (name, size, source without a query); while a link is loading, "Materials preview" and "Start" are unavailable. The preview and the start work on one set without re-downloading, "Run again" carries the link over from the snapshot and `sources.json` without the network. The MCP server does not accept links yet. Check without the network and without cost: `COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the project> node apps/desktop/scenarios/url-materials/check.ts` (`--seed-only` prepares the folder and the stand for the window).

A check of the folder snapshot by the real `council` process on a generated large folder inside `.council-data`; no models are called:

```bash
COUNCIL_DEV=1 node packages/core/scenarios/folder/check-cli.ts
```

- In a folder, hidden names, names from `defaults.materialsIgnore` in `config.json` (initially `node_modules`, `dist`, `build`), non-text files (except PDF, see below) and symbolic links are skipped, the reason is given in the summary.
- `.gitignore` rules: `.gitignore` files inside the attached folder (the root one and nested ones; a nested one acts on its own subtree) are applied as in git, including the `!` negation. Paths they exclude go neither into the initial set, nor into the folder snapshot, nor into the "Owner's folder" listing, and are printed in the summary as a separate section `Excluded by rules: <n>` — a line `  <name> — excluded by .gitignore rule: <rule>` each, a whole folder on one line (`proj/out/`), its contents are not traversed. This way build artifacts (`out/`, `release/`) do not eat the limit and the snapshot bound. Rules above the attached folder, global git settings and `.git/info/exclude` are not read; in a folder without `.gitignore` the behavior is as before; names from `defaults.materialsIgnore` keep the reason "in the ignore list". A file named explicitly in `--attach` is never excluded by rules. An unreadable `.gitignore` (no permissions, a symbolic link, larger than 1 MiB) does not reject the collection: its rules are not applied, in "Skipped" it has the reason "could not read — <reason>". The case of names in rules is not distinguished (as in git on macOS by default); the match with `git check-ignore` is checked by a core property test on generated trees.
- Folders of the same name: if several folders with one name are attached (case-insensitive and regardless of Unicode normalization form), the first keeps the name, the following get the suffix " (2)", " (3)", … — the smallest number not taken by the name of another attached folder or an already issued name (`/a/proj`, `/b/proj`, `/c/proj (2)` → `proj`, `proj (3)`, `proj (2)`). The name is common to the materials, the "Excluded by rules" section, the folder snapshot and the "Owner's materials".
- Bringing back what was excluded: `--include <path>` (repeats) brings an excluded file or folder back into the set — a folder whole, the rules inside it are not applied. The path is given as a file system path inside the attached folder or as a name from the "Excluded by rules" section (`--include proj/out/`); a name with a suffix (`--include "proj (2)/out/"`) brings back a path inside exactly that folder; a name without a suffix that fits several folders of the same name gives code 2 with a request to name the absolute path. When a file from an excluded folder is brought back, the rest of its contents stays in the section. A path the rules did not exclude rejects the start (code 2, `Materials not accepted:`). `--no-ignore` turns the rules off entirely and is incompatible with `--include` (code 2). Both flags work in `--preview-materials`; a start by `--prepared-materials <id>` uses the shown set and does not accept these flags.
- What is excluded by rules in the app: "Session setup" shows it as the section "Excluded by rules: N" with the buttons "Return" and "Exclude again" (the bridge actions `returnIgnored(id)` and `excludeIgnored(id)`); a return belongs to the current setup, is reset by "Clear" and is not carried over to a session repeat. Check without a window: `apps/desktop/scenarios/folder-ignore/check.ts` (the command is in `AGENTS.md`).

A check of the rules by the real `council` process on a fixture folder inside the project; no models are called:

```bash
COUNCIL_DEV=1 node packages/core/scenarios/ignore-rules/check-cli.ts
```

- The start is rejected (code 2, the message `Materials not accepted:` and the reasons line by line) if a path is not found or not readable, an explicitly named file is non-text (not PDF) or is a symbolic link, or an `.env` or `.env.*` file is named explicitly. The session is not created, the participants are not called.
- PDF: a file whose content starts with `%PDF-` (the extension does not matter for acceptance) is taken from the text layer; the text is extracted locally before the start by the engine's common collector, the same for `--attach`, MCP `attachments` and the app ("Attach files", "Attach a folder", drag and drop). The material name is the file name; `chars`, `sha256`, the preview, the session snapshot (`sessions/<id>/materials/mN.txt`), the folder snapshot (`workspace/`) and the turn requests carry the extracted text, the PDF bytes are not stored in the session and journal, the file is not re-read after the start. Pages go in order separated by a blank line; the order of blocks within a page is as in the PDF file and may differ from the visual one. Per-file limits: 100 MiB of size (before reading), 2000 pages, 30 seconds, 512 MiB of extractor memory, 20000000 characters of text; exceeding one is a refusal with a reason, nothing is truncated, the regular materials limit and the folder snapshot bound apply on top of this to the extracted text. Reasons: «PDF is larger than 100 MiB», «PDF has more than 2000 pages», «PDF text extraction took longer than 30 seconds», «PDF text extraction used more than 512 MiB of memory», «PDF text is longer than 20000000 characters», «PDF is encrypted — no password is requested», «PDF is damaged», «PDF has no text layer — no text recognition is performed», «could not extract PDF text — <code>». An explicitly named unfit PDF rejects the start (terminal: code 2, "Materials not accepted:"; MCP: a tool error; app: an error line in the "Materials" block, the already attached list is kept); the same PDF inside an attached folder is skipped with this reason, the rest is collected. In a folder larger than the limit, `.pdf` counts as a description when choosing the initial set. Not done: text recognition (scans without a text layer are rejected), a password prompt (a PDF with a password is rejected; a PDF that opens without a password, for example only with a print restriction, is read), images, links (a link or script inside a PDF is not opened and not executed); CJK documents on predefined CMap tables can yield empty text (the CMap tables are not shipped, the same in all three entry points). The engine reads the file itself (rules as for text ones: no symbolic links, `.env` / `.env.*` are not opened) and passes the bytes to a separate extractor process with an empty environment (no keys) and the network disabled; it does not receive paths. The collector waits for it synchronously: while the extraction runs, the process (the app window, the MCP server) does not respond — usually a fraction of a second, in the worst case 30 seconds per file; the result is remembered in the process memory for an unchanged file (device, inode, size, modification time), a repeated collection of the same attachments in the app does not extract again. Dependency: `pdfjs-dist` 6.4.299 (Mozilla PDF.js, Apache-2.0), the version is pinned in `packages/core/package.json`. Check without cost: `COUNCIL_DEV=1 COUNCIL_HOME=<new temporary folder inside the project> node packages/core/scenarios/pdf/check.ts` (real `council` and MCP over stdio, real app main modules, scripted participants, 0 model calls).
- Links: `--url <address>` (repeats, combines with `--attach`) adds the text of a public web page or document as a material; a link is taken only from this flag, addresses inside the topic or attached materials are not downloaded. Only `http` and `https` are accepted, an address with a login or password is rejected; both checks run before any network activity. Every hop (the given address and every redirect) is checked anew: the name is resolved once, all received addresses must be public (the list of non-public IPv4 and IPv6 ranges is `NON_PUBLIC_RANGES` in `packages/core/src/url/address.ts`, checked with `net.BlockList`, IPv4 forms inside IPv6 are rejected whole), the connection goes exactly to the checked address (Host and SNI stay from the link), so a DNS change after the check will not redirect the connection; at least one non-public address is a refusal before connecting. The request is `node:http`/`node:https`, method GET, `Accept: text/html, text/plain, text/markdown`, `Accept-Encoding: identity`, `User-Agent: model-council`; no cookies, authorization or provider keys, page resources (images, styles, scripts, frames) are not loaded. Per-link limits: one deadline of 15 seconds for name resolution, redirects, the response and text extraction together; no more than 3 redirects (301, 302, 303, 307, 308); no more than 2 MiB of body, including without `Content-Length`; only status 200 is accepted, a compressed response (`Content-Encoding` not `identity`) is rejected; nothing is truncated. `text/plain`, `text/markdown`, `text/html` are accepted, HTML only in UTF-8 (another `charset`, invalid UTF-8 and binary data are a refusal); plain text and markdown are taken as is. HTML is parsed by `parse5` inside a worker thread (`node:worker_threads`, 256 MiB heap, the network is closed in the thread, the thread is terminated at the deadline): the text is taken without `head`, `script`, `style`, `noscript`, `template`, `svg`, `iframe` and without elements with `hidden`, `aria-hidden="true"` or inline `display:none` / `visibility:hidden`; block elements become paragraphs separated by a blank line, `br` a line break, `pre` is kept as is, table cells are separated by a space. Not executed: JavaScript, external and `<style>` CSS (an element hidden by a stylesheet stays in the text), image `alt`, link addresses on the page, text recognition, PDF over the network, sites with a login; a page whose text appears only after JavaScript gives "no extractable text" and is rejected. A link material is an explicitly attached one: it goes after the local materials in `--url` order, goes in whole and is counted in the same `materialsChars` limit together with the explicitly attached files (over the limit — a refusal, no truncation), the folder files are chosen into the remainder of the limit. The name is built from the host and path without the `/` sign: `https://example.com/docs/page.html?x=1` gives `example.com_docs_page.html`, repeats get ` (2)`, ` (3)`. The text is stored as a regular snapshot `sessions/<id>/materials/mN.txt`, the `session_created` event still carries only `id`, `name`, `chars`, `sha256`; turns and `council resume` read only the snapshot, the network is not used after the start. The origin is written by the `sources.json` file (`{ "version": 1, "sources": [{ "id": "m2", "scheme": "https", "host": "example.com", "pathname": "/docs/page.html", "fetchedAt": "<ISO UTC>" }] }`): once next to `set.json` in `prepared-materials/<id>/` and in `sessions/<id>/materials/`, only if there is at least one link material; it describes the address given by the owner (redirects are not recorded). The query string, fragment and address credentials are not saved, not printed and do not get into logs — only the scheme, host and path; the path itself is saved, so a secret in a path will remain in the file: do not attach such links. A damaged `sources.json` of a prepared set makes the set `corrupt` (a refusal); an unreadable session `sources.json` does not block `council resume` (the text integrity is held by the snapshot `sha256`), the command prints `Link sources: could not read sources.json`. Old sessions and sets without the file are read as before. A refusal of any link is a start with code 2 and the message `Materials not accepted:` and a line `  «https://example.com/docs/page.html»: <reason>` per link (all given links are tried and all reasons are printed), the session is not created, the participants are not called. Reasons: «only http and https are supported», «an address with a login or password is not accepted», «could not parse the address», «name not found», «address <ip> is not public — download is forbidden», «redirect to a non-public address <ip> — download is forbidden», «more than 3 redirects», «redirect without a valid address», «HTTP response <code>», «compressed response (Content-Encoding: <value>) is not accepted», «format <type> is not supported — text/plain, text/markdown or text/html is required», «body is larger than 2097152 bytes», «did not finish within 15 seconds», «network error — <code>», «encoding <name> is not supported — UTF-8 is required», «non-text response (not UTF-8 or binary data)», «no extractable text (the page is empty or requires JavaScript)», «text extraction did not finish in time», «text extraction ran out of memory», «could not parse the HTML». The dependency is `parse5` 8.0.1 (MIT, the exact version is pinned in `packages/core/package.json`, one transitive dependency `entities`), it is imported only by the worker thread file `packages/core/src/url/html-worker.ts` and does not get into the app build. There is no link input in the app or in the MCP server. Downloading a public document is a network request from the owner's computer to that site, no models are called and nothing is paid. Check without cost (a local HTTP stand, the real `council` process through a test transport, scripted participants, 0 model calls; writes only to the new folder `.council-data/url-check-*` inside the repository): `COUNCIL_DEV=1 node packages/core/scenarios/url-materials/check.ts`.
- Preview and the prepared set: `council --preview-materials [--attach <path>]… [--include <path>]… [--no-ignore] [--url <address>]… [--materials-chars <n>]` prepares the materials, prints the same summary, then the exact text of the "Owner's materials" request section (full texts) and the folder listing, then `Prepared set: <id> (valid for 24 hours; no model calls were made)` and a hint line with the start command; the session is not created, the participants are not called, code 0. The topic and participants are not needed, any other start flag is rejected; at least one `--attach` or `--url` is needed. Full texts are printed only in this mode, the regular summary before the start does not print texts. `council --topic … --participant … --prepared-materials <id>` starts with exactly the shown set: without downloading and without re-reading files, the materials limit is taken from the set; the flag does not combine with `--attach`, `--url`, `--materials-chars` and `--preview-materials` (a reason and help, code 2, no network). The set lies in `prepared-materials/` of the same data folder for 24 hours (the app's preview mechanism), expired sets are not deleted automatically. An unfit set (`unknown`, `invalid`, `expired`, `corrupt`) gives `Prepared set not accepted: <reason>`, code 2.

```bash
COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --url https://example.com/docs/page.html --preview-materials
COUNCIL_DEV=1 COUNCIL_HOME=.council-data npx council --topic "Что важно в документе" --prepared-materials <id> --participant scripted:packages/core/scenarios/consensus/p1.json --participant scripted:packages/core/scenarios/consensus/p2.json --max-rounds 3
```

These two commands reach the real site `example.com` (one network request, no models are called); the stand does not need the internet.
- Inside a folder there is no refusal: an environment file (`.env`, `.env.*`) and an item that could not be read are skipped with a reason in the "Skipped" summary, and the environment file is not opened.
- `--materials-chars <n>` — the limit of volume in text characters (UTF-16 units, like `--context-chars`); by default `defaults.materialsChars` from `config.json`, initially 60000. The limit applies to the initial set: explicitly named files over it reject the start, nothing is truncated (the message names the volume, the limit and the largest files), while a folder larger than the limit is not rejected — descriptions (`md`, `markdown`, `mdx`, `txt`, `rst`, `adoc`, `pdf`) closer to the root are taken from it while they fit, and without them the files closer to the root; the rest the participants read on request. A separate bound of the folder snapshot is 20000000 characters for all text files of attached folders; exceeding it rejects the start before the participants are called.
- Reading on request, as in the app: up to 5 names and 40000 characters per request, the folder listing up to 12000 characters (the limit also applies to collapsed lines: if the listing does not fit, deep folders collapse into smaller ancestors — a line per folder with the number of files and the size, and a cut at the last whole line happens only if even the lines of the attached folders do not fit; the number of files and the size stay in the header), no more than 3 participant calls per turn. If a participant read files, after the `Arguments:` line is printed `Read from the folder: <name> — <N> characters; <name> — <shown> of <N> characters` (the same in `council show <id>` and on `council resume`).
- `council resume` takes the saved snapshot; the source folder is not read after the start and may be changed or deleted.
- Relative paths are counted from the current folder.
- A path that contains a symbolic link is rejected whole. On macOS these are `/tmp` and `/var`: give the real path — `/private/tmp/…`.

### CLI participants

Every turn is a new CLI process in an empty temporary folder: no tools, MCP servers, user instructions, hooks or skills, and no agent session persistence. The request goes through stdin, and the process gets `COUNCIL_PARTICIPANT=1`. Flags are checked against the help of the installed version; if the isolation flag is missing, the provider is unavailable. For `codex`, isolation is also confirmed by the `codex features list` output: if the list could not be read or lacks at least one disableable feature (`shell_tool` and the others from `CODEX_ISOLATION_FEATURES` in `packages/core/src/cli-agents/args.ts`), `codex` is unavailable, the reason names the version and the missing names, and a run with it is rejected before any model call; otherwise each of these features is disabled with the `--disable` flag. A check without cost is `COUNCIL_DEV=1 node packages/core/scenarios/codex-isolation/check.ts` (a `codex` stub). The command is also found with a minimal `PATH`. The app does not install, update or sign in to the CLI.

| Failure | What happens |
|---|---|
| command not found | the participant drops out, no retry |
| not signed in | the participant drops out, no retry |
| subscription limit exhausted (with the reset time, if the CLI reported it) | the participant drops out, no retry |
| timeout | one retry |
| non-zero exit code | one retry |

### HTTP participants

Any model behind an endpoint compatible with OpenAI Chat Completions (OpenRouter, a local server and others). The provider is described in the data folder's `config.json`, the key in `.env`.

1. Add an entry to `providers` in `config.json` (the data folder path: `npx council home`):

```json
{
  "id": "openrouter",
  "kind": "openai-http",
  "label": "OpenRouter",
  "models": [],
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKeyEnv": "OPENROUTER_API_KEY"
}
```

   `baseUrl` is the address up to `/chat/completions`, `http` or `https` only. `apiKeyEnv` is the name of the variable holding the key; the key itself is not in `config.json`, and a field containing it is rejected. For a local server without authorization, leave `apiKeyEnv` out. Leave `models` empty: the list is requested from the endpoint.

2. Put the key into the data folder's `.env` as a single line `OPENROUTER_API_KEY=<value>`. The key is read from an environment variable; the environment is supplemented from the data folder's `.env`, then from the `.env` in the current folder. A variable set in the environment takes precedence over the files; an empty value counts as unset.

3. Check the provider (no model is called, only the model list is requested):

```bash
COUNCIL_HOME=.council-data npx council providers
```

   Expected: a block `openrouter  openai-http  available  <address>`, a line `key: OPENROUTER_API_KEY — set` and a line `models:`. The key value is not printed.

4. Start a discussion. The model is required for an HTTP participant, and colons in its name are allowed. Calls to paid models cost money: up to `participants × rounds × 3` calls.

```bash
COUNCIL_HOME=.council-data npx council --topic "Как назвать кота" --participant openrouter:<модель> --participant openrouter:<другая модель> --max-rounds 2
```

   The text of a turn appears in the terminal in parts (the error stream), and its breakdown is printed after the turn. Chunks are not written to the event log; usage is recorded as the endpoint reported it: tokens, and cost only if it was in the response.

| Failure | What happens |
|---|---|
| key not set | the session is not created, the error names the variable and the `.env` file |
| authorization refused (401, 403) | the participant drops out, no retry |
| model not found | the participant drops out, no retry |
| rate limit exceeded (429) | one retry |
| endpoint unreachable | one retry |
| turn timeout | the request is aborted, one retry |
| server error (5xx) | one retry |

The key does not end up in `config.json`, events, the log or error texts: they contain only the variable name.

#### Check without cost: fake server

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
node packages/core/src/http/fake-server.ts --port 8787
```

The server prints `Fake server: http://127.0.0.1:8787/v1` and runs until `Ctrl+C`. Flags: `--port` (8787 by default), `--api-key <value>` — require a key, `--chunk-delay <ms>` — the pause between stream chunks (150 by default). In a second terminal, add a keyless entry to `providers` in `.council-data/config.json`:

```json
{ "id": "fake", "kind": "openai-http", "label": "Fake", "models": [], "baseUrl": "http://127.0.0.1:8787/v1" }
```

and run:

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
COUNCIL_HOME=.council-data npx council providers
COUNCIL_HOME=.council-data npx council --topic "Как назвать кота" --participant fake:fake-amend --participant fake:fake-agree --max-rounds 2
```

Expected: a block `fake  openai-http  available  http://127.0.0.1:8787/v1` with the server's model list, then two turns and `══ Outcome: consensus`. The server's behavior is set by the model name: `fake-amend` proposes a solution, `fake-agree` agrees, `fake-auth` — authorization refused, `fake-rate` — rate limit exceeded, `fake-hang` — a hang (check with `--turn-timeout 2`), `fake-error` — a server error, any other name — model not found.

## MCP server

The `osen` server lets an agent (Claude Code, Codex) start a discussion, follow it and stop it, pass the owner's messages and answers into it, and release the owner wait, without leaving the chat. The transport is stdio, the entry point is `packages/mcp/src/main.ts`.

No build is needed: `npm install` is enough (Node 22.18+ runs TypeScript itself).

The server provides instructions, tool descriptions and response texts in the interface language: `COUNCIL_LANG`, then `preferences.json` in the data folder, then English. The language is read once at startup, so after changing the language in the app the agent needs a server restart (a new agent session). Tool and field names, error codes and status values do not depend on the language; the agent replies to the owner in the owner's language. A check without cost is `packages/mcp/scenarios/language/check.ts`.

### Connecting in this project

1. The entry is already in `.mcp.json` at the repository root.
2. Start Claude Code in the project root:

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
claude
```

3. On first launch Claude Code asks about the project server `osen` — confirm.
4. Run `/mcp`: the list should show `osen` and seven tools.

The same entry by hand (it writes only to the project's `.mcp.json`; specify exactly `--scope project`, since by default the `local` scope writes to the user's personal settings):

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
claude mcp add --scope project osen -- node packages/mcp/src/main.ts
```

The agents' global settings are not changed.

Codex does not read `.mcp.json`. Without an entry in `~/.codex/config.toml`, the server is connected for a single run with `-c` flags (a permanent connection for both agents is made by the installation from the section README, "Skill for agents"):

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
codex -c 'mcp_servers.osen.command="node"' -c "mcp_servers.osen.args=[\"$PWD/packages/mcp/src/main.ts\"]"
```

### Tools

| Tool | Purpose |
|---|---|
| `council_options` | Templates, providers with availability and models, defaults (including the materials limit and the token ceiling `maxTotalTokens`, `null` — no ceiling), `lineups` (`id`, `name`, the `available` flag and positions: `providerId`, `model`, `role`, `available`, `reason`, `modelNote`) and `lineupsError` (the reason if the lineups file is corrupted, otherwise `null`). Starts nothing and writes nothing |
| `council_start` | `topic`, optional `templateId`, `participants` (`[{ providerId, model? }]`, at least two) or `lineupId` (a lineup identifier from `council_options`; together with `participants` it is a tool error, even if the lists are equal; with neither — default participants), `maxRounds` (1–20), `attachments` (absolute paths to files and folders), `maxTotalTokens` (the session's total token ceiling, an integer of at least 1), `pauseAfterRound`, `waitForOwner`, `ownerWaitSec` (explicitly enabling the owner wait per the engine contract; without them the session does not wait; `ownerWaitSec` is an integer from 1 to 86400, 300 by default, and is set only together with one of the modes; an invalid duration is rejected before the session is created). It immediately returns `sessionId`, the upper bound on the number of calls `maxCalls` (participants × rounds × 3), `materials` — the number of materials, their size in characters, skipped paths with reasons and `left` (how many folder files did not fit into the initial set, and the first 20 with reasons) — `folder` (the number of files and the size of the folder snapshot, or `null` if no folder is attached), the effective `maxTotalTokens` ceiling (`null` — no ceiling), `ownerWait` (the enabled modes and the duration, or `null`) and `lineup` (`id`, `name`, `notes` — notes about models that are not in the current list; `null` without a lineup); the session runs in the background; `drafts` (`false` by default) and `synthesizerId` (only with `drafts: true`) enable the "independent drafts" experiment: in the response `maxCalls` = participants × (rounds + 1) × 3 and the `drafts` field (`{ synthesizerId, synthesizerName, byDefault }` or `null`) |
| `council_status` | `sessionId`, optional `waitSec` (returns earlier on a new completed turn, an applied message or an owner's answer, a change of questions or of the wait, or the end of the session). Status, round, agreeing participants, the current version of the solution, the names and total size of the materials (without texts), `folder` (the number of files and the snapshot size, or `null`), `filesRead` (snapshot files read by participants in completed turns, without texts: `turn`, `participantId`, `name`, `chars`, `shown`; an empty list for a session without a folder), the effective `maxTotalTokens` ceiling and the total tokens `tokens` (with an incomplete-accounting flag); after completion — the outcome, the stop reason `reason` (`token_cap` — the token ceiling was reached), objectors with arguments, statistics; if the owner accepted a version in the app — `ownerSelection` (`version`, `text`, `note`, `selectedAt`, `statusAtSelection`): this is the owner's choice, not the models' agreement, and `status` and `solution` stay as they were; without a choice the field is absent; `ownerQuestions` — open questions to the owner (identifier, author, text, turn number); `waiting` — the current wait (`waitId`, reasons, held questions, deadline) or `null`, and for an interrupted session the saved wait is returned separately from the status; `ownerMessages` — applied owner messages without texts (`requestId`, turn number, answered questions); `drafts` — `null` or `{ phase: "drafting" | "finished", synthesizerId, accepted, total, items[] }` with the texts of accepted drafts from verified snapshots (a corrupted snapshot — `text: null` and `error`); this is neither a solution nor an agreement, and a new draft wakes the `waitSec` wait |
| `council_stop` | `sessionId`. Stops the session, including one started from the app or with the `council` command |
| `council_say` | `sessionId`, `text`, optional `questionId` (the identifier of an open question from `ownerQuestions`). The owner's message or answer to a question, into a running session. Returns the `requestId` of the request accepted into the queue, not a confirmation that it was applied |
| `council_continue` | `sessionId`, `waitId` (from `waiting` in `council_status`). Releases the current owner wait. Returns the `requestId` of the request accepted into the queue, not a confirmation of the release |
| `council_resume` | `sessionId`, optional `rounds` (how many more rounds, an integer from 1 to 20; if omitted — the remainder of the previous limit), `maxTotalTokens` (a new token ceiling; `null` removes the ceiling), `replacements` (`[{ participantId, providerId, model }]`: replacements for dropped or unavailable participants), `execute` (`false` by default), `planToken`. Resumes a saved session. Without `execute` — a plan: the roster of active participants with the spend flag (`billing`: `subscription`, `paid`, `free`; with replacements — the future roster), `replacements` (old → new, reason), `agreementReset`, `requiresConsent`, the number of rounds, the upper bound on calls `maxCalls` (active × rounds × 3), the effective ceiling and the tokens already spent, the saved owner wait (`waiting`) and `planToken`; the plan writes nothing and calls no models. With `execute: true` and `planToken` — a background continuation of the same journal with the same `sessionId`; the `accepted` response comes right after the resume event is written, and the turn and the outcome are read in `council_status`; in the plan, `draftCalls` is the remainder of calls of unfinished drafts, it is included in `maxCalls` and thereby in `planToken`; a corrupted draft snapshot is a `draft` refusal |

### Behavior

- `council_start` returns immediately; the agent reads the progress of the discussion through `council_status` with `waitSec` (waiting for a change, at most 50 seconds; a larger value is truncated, and this is visible in the response).
- The session lives in the server process. When the agent is closed, the server exits, and the session stays in History with the status "interrupted"; completed turns are kept.
- A discussion participant cannot convene a discussion itself: with `COUNCIL_PARTICIPANT=1` in the server environment, `council_start`, `council_say`, `council_continue` and `council_resume` are rejected (the engine sets this variable for CLI participants).
- The owner wait is enabled only explicitly by `council_start` fields; it is finite — after the duration the discussion continues by itself. While the session waits, `council_status` returns `waiting` and `ownerQuestions`, and `statusText` is "running, waiting for the owner".
- `council_say` and `council_continue` also work with sessions started from the app or with the `council` command. Both only put a request into the live executor's queue — the application is read in `council_status` (`ownerMessages`, `waiting`). `council_continue` does not start a new session and does not add rounds, but the previous executor will keep calling models within the limits already agreed.
- `council_resume` resumes sessions with the status `interrupted`, `no_consensus`, `stopped` and `failed` with `reasonCode` `insufficient_active_participants` (visible in `council_status`; replacements are needed that leave at least two active participants, otherwise `too_few_active`); `consensus`, any other `failed` and a running session are refused. The roster, roles, order and models are taken from the journal, and default participants are not substituted; the roster changes only through `replacements` named by the owner (the agent chooses neither provider nor model; values come from `council_options`). Replacing an available active participant, a duplicate, an unknown or already replaced `participantId`, or an unavailable new participant is a `replacement` refusal before anything is written; the former participant stays in the history (`council_status`: `replacedBy` on it, `replaces` on the new one), and agreements are reset. An unavailable participant without a replacement produces a refusal with its identifier and reason already at the plan. The `stale_plan` error means the journal, replacements, participant availability or parameters changed after the plan: a new plan and the owner's new consent are needed. Only one executor resumes a session at a time, and a second launch gets `busy` or `running`. Unapplied owner messages dropped on acceptance are returned in `droppedOwnerRequests` and are not written to the server log; if the server exits during a resumed turn or wait, the session stays `interrupted` with the saved turns and the wait deadline.
- The server cannot verify that the owner agreed to the resume: this rule is written in the server's instructions and the tool description (first the plan, a message to the owner with the topic, participants, rounds and the exact call bound, consent when `requiresConsent`, then `execute`). `planToken` only confirms that exactly the plan shown is run, and is not stored anywhere.
- A run with real participants spends subscriptions or money. Spend can be limited with a token ceiling (`maxTotalTokens` in `council_start`; by default `defaults.maxTotalTokens` from `config.json`, if set): the session stops by itself with the status `stopped` and the reason `token_cap` when the sum of tokens across turns reaches the ceiling; the check runs between turns, so the overshoot is at most one turn.
- The owner's materials are passed in `attachments` of `council_start` only as absolute paths: the server's working folder is not the project, and a relative path is rejected. A PDF with a text layer is accepted under the same rules (see README, "Materials"). The collection rules and the limit are the same as for `council --attach` (`defaults.materialsChars` from `config.json`, 60000 characters by default; `council_options` returns it in `defaults`), with no differences: a folder larger than the limit is accepted, its files are kept in the snapshot, descriptions go into the initial set, and participants read the rest on request. A collection refusal (path not found, an explicitly named environment file or non-text file, explicitly named files larger than the limit, or a folder larger than the snapshot bound of 20000000 characters; `.env` and anything unreadable inside a folder are skipped) is returned as an error with all the reasons, and no session is created. Materials go into every call of every participant; the `maxCalls` formula does not depend on them. Material texts and source paths are not written to `logs/app.log` — only the count and size.
- The server itself passes the agent the rules of work (MCP protocol instructions): tell the owner the topic, participants, round limit and the upper bound on calls before starting, wait for consent to the spend, do not write on every turn, take the outcome only from the `council_status` response; attach only the files the owner named, by absolute paths, and tell the number and size of the materials, and for a folder larger than the limit — the snapshot size and the number of files that did not fit; pass messages, answers to questions to the owner and the release of a wait only at the owner's request and do not answer for them. They apply without the skill too.
- Lineups (see README, "Lineups" in the section "The `council` command") are read from `lineups.json`; an unknown or unavailable lineup is a `council_start` error before the session is created. A lineup cannot be saved through MCP, only with the `council lineups save` command. Rule 10 of the server instructions: the agent takes lineups from `council_options`, names the lineup's participants (provider, model, role) to the owner before starting and waits for consent on the same terms, does not start an unavailable lineup and does not substitute participants, and passes notes about models to the owner.
- Drafts (`drafts`, `synthesizerId` in `council_start`) are an experiment: the rule in the server instructions says to enable them only at the owner's request and to name the synthesizer and the call bound `participants × (rounds + 1) × 3` to the owner before starting. Description: "Independent drafts (experiment)".
- The session lands in the same data folder (see "Data") and is visible in the app's History with the source "MCP".
- A journal that was not read in full: `council_status` returns the `journal` field — `null` or `{ reason: "newer_version" | "corrupted", lastEvent }`. With `newer_version` the journal was written by a newer version of the app: `statusText` for a session without a recorded outcome says "state undetermined", the outcome and solution are taken from the part that was read, the agent must not call such a session interrupted, and the owner needs to update the app. The errors of `council_resume`, `council_say` and `council_continue` for such a session begin with the code `newer_version`, and the journal is not changed; `council_stop` is not rejected because of the journal.
- Diagnostics are written to `logs/app.log` in the data folder (component `mcp`); only protocol messages go to standard output.

### Check without cost

Scripted participants are available to the server only with `COUNCIL_DEV=1`. Manual launch (the server waits for protocol messages on standard input; any MCP client is needed to make calls):

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
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
cd "/Users/korat/Desktop/Мозговой штурм"
COUNCIL_DEV=1 COUNCIL_HOME="$PWD/.council-data/acceptance-36-$(date +%Y%m%d-%H%M%S)" node packages/mcp/scenarios/owner-control/check.ts
```

A live stand for resuming (0 model calls): a server over stdio, the executor of the original session is a separate `council` process, participants are scripted.

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
COUNCIL_DEV=1 COUNCIL_HOME="$PWD/.council-data/acceptance-37-$(date +%Y%m%d-%H%M%S)" node packages/mcp/scenarios/resume/check.ts
```

A stand for participant replacement on resume (0 model calls; real `council` and a server over stdio, scripted participants; it creates the data folder itself inside `.council-data/`):

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
COUNCIL_DEV=1 node packages/core/scenarios/replacement/check.ts
```

A live stand for the folder snapshot through MCP (0 model calls): a server over stdio, scripted participants; the stand creates a unique data folder inside `.council-data` itself.

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
COUNCIL_DEV=1 node packages/mcp/scenarios/folder/check.ts
```

A live stand for named lineups (0 model calls): real `council` processes and the MCP server over stdio, scripted participants and a fake HTTP server; the result is a `PASS` line.

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
COUNCIL_DEV=1 COUNCIL_HOME="$PWD/.council-data/acceptance-44-$(date +%Y%m%d-%H%M%S)" node packages/mcp/scenarios/lineups/check.ts
```

## Skill for agents

The `osen` skill teaches an agent to convene a discussion of several models at the owner's request: "собери совет моделей" ("convene a council of models"), "обсуди с несколькими моделями" ("discuss with several models"), "пусть модели поспорят" ("let the models argue"), "мозговой штурм моделей" ("brainstorm of models"). The agent takes templates and providers from the server, names the topic, the participants, the round limit and the upper bound on the number of calls (participants × rounds × 3), waits for consent if the participants consume a subscription or money, starts the session, quietly waits for the result and brings back a report: status, lineup with the limit and the number of calls, decision, objections, spend and a pointer to open the session in the app. The skill does not trigger on an ordinary brainstorm with the agent itself. If the server is not connected, the agent says so and names the install command instead of answering for several models.

The skill source is `skill/osen/SKILL.md`; the trigger test phrases are in `skill/trigger-phrases.md`.

### Skill and installer language

- The skill text is a single English text: it is an instruction to the agent, not an interface, and the language choice in "Settings" does not affect it. The agent replies to the owner in the language of the owner's request: the pre-start message and report templates in the skill are English samples, the agent translates the labels, and leaves tool names, field names and server texts as they are.
- The skill description contains invocation phrases and exclusion phrases in two languages: the earlier Russian ones verbatim ("собери совет моделей", "обсуди с несколькими моделями", "пусть модели поспорят", "мозговой штурм моделей", "созови совет", "пусть Claude и Codex обсудят и договорятся"; exclusions "обсуди со мной", "что думаешь", "давай набросаем идеи для названия") and English ones ("convene a council of models", "discuss with several models", "let the models argue", "brainstorm of models", "let Claude and Codex discuss and agree"; exclusions "discuss with me", "what do you think", "let's brainstorm names"). The description is at most 1024 characters, the limit for a skill description.
- The output of `skill/install.ts` (help, preview, installation, removal, mismatches and errors) is in the current language: `COUNCIL_LANG` (`en` or `ru`) → `preferences.json` in the data folder (`COUNCIL_HOME` or the owner's folder) → English. A corrupted `preferences.json` gives English with no message. Paths, commands, agent names, exit codes and the list of actions do not depend on the language. Example: `COUNCIL_LANG=ru node skill/install.ts --dry-run`.
- The copy of the skill installed for the agents does not update itself: the new text reaches them only after a repeat installation (the preview shows "will be updated").

### Where agents keep skills and servers

| | Claude Code | Codex |
|---|---|---|
| Skills folder | `~/.claude/skills/<name>/SKILL.md` | `~/.codex/skills/<name>/SKILL.md` |
| Where servers are recorded | `~/.claude.json`, key `mcpServers` (scope `user`) | `~/.codex/config.toml`, table `[mcp_servers.<name>]` |
| Registration command | `claude mcp add --scope user osen -- node <repository>/packages/mcp/src/main.ts` | `codex mcp add osen -- node <repository>/packages/mcp/src/main.ts` |
| Removal command | `claude mcp remove --scope user osen` | `codex mcp remove osen` |
| Peculiarity | does not overwrite an existing entry with the same name | silently overwrites an existing entry, so the installation first checks it with `codex mcp get osen --json` |

### Installation

Installation writes to the agents' global settings (Node 22.18+, run from the repository root) and is done only with the owner's consent.

1. Preview: prints every entry the installation will create or change, with the full path, and changes nothing.

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
node skill/install.ts --dry-run
```

2. Installation: for each agent found, copies the skill into its skills folder (next to it, puts a `.osen-install` marker file with the repository path) and registers the server with the agent's own command. An agent that is not on the machine is skipped with a message. Then it removes the former `model-council` entries created by an installation from this repository before the rename: the `model-council` skill folder with the `.model-council-install` marker (this repository's path) and `name: model-council` in `SKILL.md`, and the `model-council` server that runs this repository's `packages/mcp/src/main.ts`. An agent's former entries are removed only if `osen` was set up for it without mismatches.

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
node skill/install.ts
```

3. Restart Claude Code and Codex.
4. Check in Claude Code: `/mcp` shows the `osen` server (and does not show `model-council`) and seven tools; then the phrase "собери совет моделей по вопросу …" ("convene a council of models on the question …") triggers the skill.

Codex asks for confirmation to call the server's tools; in a run without a window (`codex exec`) confirmations are forbidden, and the council will not start.

Output lines: `<Agent> · skill · <action> · <path>` and `<Agent> · server · <action> · <settings file> · node <main.ts path>` (in Russian, "скилл", "сервер"); removal of the former server is the line `<Agent> · server model-council · <action> · …`, of the former folder, a skill line with the path `…/skills/model-council`. Exit codes: 0 — success, 1 — mismatch or agent CLI error, 2 — argument error.

### Removal

Preview, then removal: only its own skill folder (with the marker of this copy of the repository) and only its own server entry (the `node` command and this repository's `packages/mcp/src/main.ts` path) are removed — both `osen` and the former `model-council` ones of this installation.

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
node skill/install.ts --uninstall --dry-run
node skill/install.ts --uninstall
```

### Guarantees

- A repeat installation changes nothing and reports "Everything is already installed." ("Всё уже установлено." in Russian); a skill changed in the repository it updates.
- Other people's things are not touched: an `osen` folder without a marker or with the marker of another copy of the repository (the output names the path from the marker) and an `osen` server with a different path are not overwritten; a former `model-council` folder without the `.model-council-install` marker, with a different path in the marker or a different `name`, and a `model-council` server with a different path are not removed. The script reports the mismatch and exits with code 1. Other skills, servers and settings are not changed.
- The server is registered by the absolute path of this repository: if the repository folder is moved, the installation must be repeated (first `--uninstall` from the old location, or delete the entry with the agent's command).

### Trial run without changing settings

Both agents and the script respect `HOME`, so with a substituted `HOME` everything is written to a temporary folder and the real settings do not change.

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
HOME=$(mktemp -d) node skill/install.ts
```

## Interface language

Two languages: English and Русский. English by default. The language is chosen in the "Language" block on the "Settings" screen and applies immediately, without a restart. Order of sources: the `COUNCIL_LANG` variable (`en` or `ru`) → the `preferences.json` file in the data folder → English. The variable can also be set in the data folder's `.env`; while it is set, the choice in the app is unavailable, and the block says so. If the data folder is unavailable (moving the former `model-council` folder failed), the refusal "Data folder is unavailable" from `council`, the MCP server and in the app's startup error window is printed in the language of the process environment's `COUNCIL_LANG`, otherwise in English; `preferences.json` and `.env` of the unavailable folder are not read in that case. The `council` command and the MCP server take the language at startup. For now the app shell and the "Settings", "Discussion", "New discussion", "Session setup" and "Discussion template" screens are shown in the chosen language, together with the app's refusals on those screens; the output, the `--help` help and the refusals of the `council` command and all its subcommands are printed in the language determined at startup before argument parsing (even a flag error); there is no separate language flag, the help names the source of the language; exit codes, commands, flags, identifiers and numbers are the same in both languages, model replies and what is recorded in the log are not translated. The MCP server gives instructions, tool descriptions and response texts in the same language; the remaining screens are translated by the next changes in the queue. The material name "Solution of the previous session <date>", the "(copy)" suffix and the name of a scripted participant are recorded in the language at the moment of creation and are not translated after the language changes.

The language of requests to models is the session language: it is fixed at creation from the current language (from the app, `council` or MCP) and does not change on resume, participant replacement or language change. In this language the engine assembles the protocol rules, section headings, the turn log, the correction request and the CLI participant's system prompt; the topic, materials, messages and model replies are passed as they are, and the language of the model's reply is not specified. Sessions created before this version are Russian. Check without cost (real `council` processes, scripted participants, 0 model calls):

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
COUNCIL_DEV=1 COUNCIL_HOME="$(mktemp -d "$PWD/.council-data-session-language-XXXXXX")" node packages/core/scenarios/session-language/check.ts
```

Check without cost (real main modules and the `council` process, 0 model calls); `--seed-only` prepares the data folder for the app window:

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
COUNCIL_DEV=1 COUNCIL_HOME="$(mktemp -d "$PWD/.council-data-language-XXXXXX")" node apps/desktop/scenarios/language/check.ts
COUNCIL_DEV=1 COUNCIL_HOME="$(mktemp -d "$PWD/.council-data-language-XXXXXX")" node apps/desktop/scenarios/language/check.ts --seed-only
```

## Versions and releases

The product has a single version — `version` in `apps/desktop/package.json`, following [SemVer](https://semver.org/). Each released version has an annotated tag `vX.Y.Z` and a section in [CHANGELOG.md](CHANGELOG.md). Versions and tags are not changed by hand.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): description`, where the scope is a change number or a part of the code.

| Type | When | Release level | CHANGELOG section |
|---|---|---|---|
| `feat` | new feature | minor | "Added" |
| `fix` | fix | patch | "Fixed" |
| `perf` | faster with no change in behavior | patch | "Performance" |
| `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert` | everything else | — | not included |
| `!` before the colon or `BREAKING CHANGE: …` in the body | incompatible (log, config, MCP) | major | "Breaking changes" |

The hooks in `.githooks/` are connected by `npm install` (the `prepare` script); in an already installed folder — `git config core.hooksPath .githooks`. `commit-msg` rejects a message that does not match the format; `pre-push` rejects a tag that does not match the version in `apps/desktop/package.json` and runs the type check and tests.

Changes go through a feature branch and a pull request. CI checks types, the full test suite and the desktop build; PR titles use Conventional Commits. Squash merge keeps one semantic commit per PR. `main` requires passing CI and resolved conversations, with no external reviewer required for this single-owner project. Force pushes and branch deletion are blocked. GitHub security alerts and Dependabot update PRs cover dependency maintenance.

Releases have two stages. Start from clean `main` synchronized with `origin/main`:

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
git switch main
git pull --ff-only origin main
npm run release -- --dry-run
npm run release
```

Both commands refresh `origin/main` and refuse unsynchronized or dirty trees. The preview writes no files or tags. Preparation runs `typecheck` and the full test suite, creates `codex/release-vX.Y.Z`, updates the desktop version and lockfile, inserts the CHANGELOG section, and commits `chore(release): vX.Y.Z`. It does not tag or push. The level comes from commits after the latest reachable version tag; an explicit level/version is supported: `npm run release -- patch` (`minor`, `major` or `X.Y.Z`). For the initial public history without a reachable tag, the root commit is the baseline only if its desktop version matches the current version. Unrelated old local tags and history remain untouched.

Push the branch printed by the command and open a PR titled `chore(release): vX.Y.Z`. After successful CI, squash merge with that title; GitHub may append its `(#123)` PR number. Then publish its tag from synchronized main:

```bash
cd "/Users/korat/Desktop/Мозговой штурм"
git switch main
git pull --ff-only origin main
npm run release -- publish
```

Publishing finds the latest release commit on main for the current desktop version, verifies its version, lockfile and first CHANGELOG section agree, and checks that the release commit contains only those three files. It creates an annotated `vX.Y.Z` tag on that release commit and pushes only that tag. Other PRs may already have advanced main; publishing still tags the validated release commit. A failed push can be retried; an existing tag must be annotated and point to the same commit. Never use `--follow-tags`: historical local tags are not part of this publishing flow.

The tag workflow verifies the release and main ancestry, runs checks, builds the arm64 DMG, validates its contents and creates a **draft** GitHub Release with the image, SHA256 checksums and CHANGELOG notes. Review and publish the draft explicitly. The existing ad hoc macOS signature is preserved; Apple notarization is not configured. Installation remains a separate owner-approved step in [docs/deploy.md](docs/deploy.md), "Update".

To verify packaging without issuing a version, open **Actions → Release → Run workflow**, select **main**, keep **build_only** checked, and click **Run workflow**. This runs the same image checks and uploads a DMG/checksum artifact; it creates no version, tag or GitHub Release.

## Data

By default — `~/Library/Application Support/osen` (on macOS), `$XDG_CONFIG_HOME/osen` or `~/.config/osen` (other systems); overridden by the `COUNCIL_HOME` variable. In development — `.council-data/` in the project root (in `.gitignore`).

Moving from the former `model-council` folder. On the first start of the app, the MCP server or `council` without `COUNCIL_HOME`, the former folder is moved automatically: a copy `model-council-backup-<YYYYMMDD-HHMMSS>` is created next to it, the folder is renamed to `osen`, a link `model-council` → `osen` is left in the former place (old versions keep working with the same data), and a line about the move is written to `osen/logs/app.log`. The skill installer does not move the folder in any mode: it reads the output language from the former folder's `preferences.json` with no changes on disk. While a session is running in the old folder, the move is postponed until the next start. If both folders exist, `osen` is used, the log has a warning, and nothing is merged. A failure of the copy or the rename leaves `model-council` untouched, and the start fails with the path and the reason. The link and the copy can be deleted after checking the new version (history and settings are in place):

```bash
rm "$HOME/Library/Application Support/model-council"
rm -rf "$HOME/Library/Application Support/model-council-backup-"*
```

- `history-pins.json` — pins of the "History" screen: `{ "pinnedSessionIds": [ … ] }`. Read and written only by the app; it has no search, filter, session content or secrets, and session logs are not changed. A missing or corrupted file means "no pins"; the app does not fix or overwrite a corrupted file — the owner edits or deletes it. The `council` command does not read it.
- `config.json` — the participant registry: created on first start from the CLIs found, an existing file is not overwritten; there are no keys in the file. Fields: `providers[]` (`id`, `kind`, `label`, `agent`, optional `path` — an explicit path to the executable, `models` — the owner's list on top of the CLI's list) and `defaults` (`maxRounds`, `turnTimeoutSec`, `contextChars`, `maxParticipants`, `materialsIgnore`, `materialsChars`, `participants[]`). Contents after the first start with two CLIs:

```json
{
  "providers": [
    {
      "id": "claude",
      "kind": "cli",
      "label": "Claude Code",
      "agent": "claude",
      "models": []
    },
    {
      "id": "codex",
      "kind": "cli",
      "label": "Codex",
      "agent": "codex",
      "models": []
    }
  ],
  "defaults": {
    "maxRounds": 5,
    "turnTimeoutSec": 300,
    "contextChars": 24000,
    "maxParticipants": 8,
    "materialsIgnore": [
      "node_modules",
      "dist",
      "build"
    ],
    "materialsChars": 60000,
    "participants": [
      {
        "providerId": "claude",
        "model": "default"
      },
      {
        "providerId": "codex",
        "model": "default"
      }
    ]
  }
}
```

  `defaults.materialsIgnore` — names of files and folders that are skipped at any depth when a materials folder is attached; names only, no paths or patterns; initially `node_modules`, `dist`, `build`. `defaults.materialsChars` — the limit on the total text of materials in characters (UTF-16 units, like `contextChars`); initially 60000; when exceeded, the start is rejected, nothing is truncated. In an old `config.json` without these fields the initial values are used, and the file is not rewritten on read. `defaults.maxTotalTokens` — an optional ceiling on total tokens for new sessions (an integer of at least 1); if the field is absent there is no ceiling, and it is not in the initial file; see README, "Token ceiling".

- `templates/` — user discussion templates (`*.json`; the template editor in the app also adds to them) and its own neutral framing (`neutral.md`); format — [docs/templates.md](docs/templates.md). User templates have no language and are shown as written; built-in ones are taken from the set for the interface language.
- `lineups.json` — named participant lineups (see README, "Lineups"): a JSON array of `{ id, name, participants[] }`, with no keys or paths to materials. No file means no lineups; the program does not fix or replace a corrupted file, the owner edits or deletes it. Written under the `lineups.lock` lock.
- `sessions/<id>/events.jsonl` — the session log: one JSON line per event, fields `seq`, `ts`, `type`; opens in any text editor. Reading stops at the first unreadable line and names the reason: `newer_version` (the line is intact but unknown to this version of the app: the log was appended by a newer version) or `corrupted` (a truncated or damaged record). Reading does not go past that line, the state is built from what was read, the log is not changed on reading, and the owner's sessions are not repaired.
- `sessions/<id>/materials/m1.txt`, `m2.txt`, … — snapshots of the texts of the owner's materials, if attached; written before the start and not changed; for link materials, `sources.json` (origin) lies next to them.
- `prepared-materials/<id>/` — prepared sets of materials for preview (`set.json` with the texts and `set.sha256` with the checksum; a set with links also contains `sources.json`); a set is valid for 24 hours, is not deleted automatically, and the `prepared-materials/` folder can be deleted manually: sessions and history do not change as a result.
- `sessions/<id>/drafts/d1.txt`, `d2.txt`, … — snapshots of the texts of accepted independent drafts (`d<N>`, N is the participant's place in the list); written before the `draft_completed` event, an accepted snapshot does not change; the folder exists only for sessions with `--drafts`.
- `sessions/<id>/owner-messages/` — the queue of the owner's messages for a running session: one file per message from `council say`; an applied request is deleted, and after the session finishes the folder does not exist.
- `logs/app.log` — the log.
- `.env` — keys of HTTP providers, one `NAME=value` per line; the name is given in `config.json` in the `apiKeyEnv` field (see README, "HTTP participants").

Sessions are not deleted or overwritten. The `interrupted` status is derived: there is no finish record and the executor process is not running.

Installation, `.env`, startup and the "it works" criterion are described here by the change that introduces them.

# Data and interface language

## Data

By default — `~/Library/Application Support/osen` (on macOS), `$XDG_CONFIG_HOME/osen` or `~/.config/osen` (other systems); overridden by the `COUNCIL_HOME` variable. In development — `.council-data/` in the project root (in `.gitignore`).

Moving from the former `model-council` folder. On the first start of the app, the MCP server or `council` without `COUNCIL_HOME`, the former folder is moved automatically: a copy `model-council-backup-<YYYYMMDD-HHMMSS>` is created next to it, the folder is renamed to `osen`, a link `model-council` → `osen` is left in the former place (old versions keep working with the same data), and a line about the move is written to `osen/logs/app.log`. The skill installer does not move the folder in any mode: it reads the output language from the former folder's `preferences.json` with no changes on disk. While a session is running in the old folder, the move is postponed until the next start. If both folders exist, `osen` is used, the log has a warning, and nothing is merged. A failure of the copy or the rename leaves `model-council` untouched, and the start fails with the path and the reason. The link and the copy can be deleted after checking the new version (history and settings are in place):

```bash
rm "$HOME/Library/Application Support/model-council"
rm -rf "$HOME/Library/Application Support/model-council-backup-"*
```

- `history-pins.json` — pins of the "History" screen: `{ "pinnedSessionIds": [ … ] }`. Read and written only by the app; it has no search, filter, session content or secrets, and session logs are not changed. A missing or corrupted file means "no pins"; the app does not fix or overwrite a corrupted file — the owner edits or deletes it. The `council` command does not read it.
- `config.json` — the participant registry: created on first start from the CLIs found (a pinned CLI that failed its pre-launch check is added too and shown unavailable with the check reason), an existing file is not overwritten; there are no keys in the file. Fields: `providers[]` (`id`, `kind`, `label`, `agent`, optional `path` — an explicit path to the executable, `models` — the models added by the owner, shown together with the list requested from the CLI) and `defaults` (`maxRounds`, `turnTimeoutSec`, `contextChars`, `maxParticipants`, `materialsIgnore`, `materialsChars`, `participants[]`). Contents after the first start with two CLIs:

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

  `defaults.materialsIgnore` — names of files and folders that are skipped at any depth when a materials folder is attached; names only, no paths or patterns; initially `node_modules`, `dist`, `build`. `defaults.materialsChars` — the limit on the total text of materials in characters (UTF-16 units, like `contextChars`); initially 60000; when exceeded, the start is rejected, nothing is truncated. In an old `config.json` without these fields the initial values are used, and the file is not rewritten on read. `defaults.maxTotalTokens` — an optional ceiling on total tokens for new sessions (an integer of at least 1); if the field is absent there is no ceiling, and it is not in the initial file; see [docs/cli.md, "Token ceiling"](cli.md#token-ceiling).

- `templates/` — user discussion templates (`*.json`; the template editor in the app also adds to them) and its own neutral framing (`neutral.md`); format — [docs/templates.md](templates.md). User templates have no language and are shown as written; built-in ones are taken from the set for the interface language.
- `cli-verified.json` — the optional local record of verified CLI versions (see [Verified CLI versions](#verified-cli-versions-cli-verifiedjson)): next to `config.json`, written through `addLocalEntry` by `council cli candidates` and the app's daily candidate check (level `interface`) and by `council cli accept` (level `real`); no file means only the built-in record.
- `cli-reminder.json` — the planned CLI transition period and the result of the last candidate check (see [CLI transition reminder](#cli-transition-reminder-cli-reminderjson)): next to `config.json`, outside `cli/`. No file means the period 30 and no recorded check; reading never creates it.
- `lineups.json` — named participant lineups (see [docs/cli.md, "Lineups"](cli.md#lineups)): a JSON array of `{ id, name, participants[] }`, with no keys or paths to materials. No file means no lineups; the program does not fix or replace a corrupted file, the owner edits or deletes it. Written under the `lineups.lock` lock.
- `sessions/<id>/events.jsonl` — the session log: one JSON line per event, fields `seq`, `ts`, `type`; opens in any text editor. Reading stops at the first unreadable line and names the reason: `newer_version` (the line is intact but unknown to this version of the app: the log was appended by a newer version) or `corrupted` (a truncated or damaged record). Reading does not go past that line, the state is built from what was read, the log is not changed on reading, and the owner's sessions are not repaired.
- `sessions/<id>/materials/m1.txt`, `m2.txt`, … — snapshots of the texts of the owner's materials, if attached; written before the start and not changed; for link materials, `sources.json` (origin) lies next to them.
- `prepared-materials/<id>/` — prepared sets of materials for preview (`set.json` with the texts and `set.sha256` with the checksum; a set with links also contains `sources.json`); a set is valid for 24 hours; sets older than 24 hours (by `createdAt`) are removed when a new set is prepared, unreadable or damaged folders are left, and the `prepared-materials/` folder can still be deleted manually: sessions and history do not change as a result.
- `sessions/<id>/drafts/d1.txt`, `d2.txt`, … — snapshots of the texts of accepted independent drafts (`d<N>`, N is the participant's place in the list); written before the `draft_completed` event, an accepted snapshot does not change; the folder exists only for sessions with `--drafts`.
- `sessions/<id>/owner-messages/` — the queue of the owner's messages for a running session: one file per message from `council say`; an applied request is deleted, and after the session finishes the folder does not exist.
- `launch/<id>.<launchId>.json` — the launch file of an MCP-started or MCP-resumed session (mode 0600, no secrets): written by the MCP server, deleted by the executor once read, 15-second deadline; `launch/<id>.<launchId>.err` — the executor's stderr until the first event, deleted by the server; `launch/<id>.<launchId>.accepted.json` — the resume acceptance, read and deleted by the server. `launchId` is new for every launch, so parallel launches of one session have separate files; files of earlier versions without `launchId` are not read.
- `logs/app.log` — the log.
- `.env` — keys of HTTP providers, one `NAME=value` per line; the name is given in `config.json` in the `apiKeyEnv` field (see [docs/participants.md, "HTTP participants"](participants.md#http-participants)).

Sessions are not deleted or overwritten. The `interrupted` status is derived: there is no finish record and the executor process is not running.

Installation, `.env`, startup and the "it works" criterion are described here by the change that introduces them.

## Verified CLI versions (`cli-verified.json`)

Which versions of the `claude` and `codex` CLIs were checked is data, not code. The effective record is the union of two sources: the built-in record shipped with the app (`packages/core/src/cli-agents/verified-record.json`) and the optional local record `cli-verified.json` in the root of the data folder (next to `config.json` and `preferences.json`).

```json
{ "schemaVersion": 1, "entries": [
  { "agent": "claude", "version": "2.1.288", "level": "real", "checkedAt": "2026-10-07",
    "os": "darwin-arm64", "osenVersion": "0.1.0", "modelCalls": 3 } ] }
```

- `agent` — `claude` or `codex`; `version` — `x.y.z`; `level` — `interface` or `real`; `checkedAt` — `YYYY-MM-DD`; `os` — `<platform>-<arch>`, for example `darwin-arm64`; `osenVersion` — the app version that did the check.
- `sha256` is optional, 64 hex characters; it is stored only and not compared in this version.
- `modelCalls` is an integer of at least 1: required for `real`, forbidden for `interface`.
- Unknown fields are rejected.

Levels: `interface` — the CLI's help and feature list were checked without a model call; `real` — a real turn of this version with the isolation check was recorded. A successful `--version` or `--help` never gives more than `interface`.

Built-in entries: `claude` 2.1.288 `real` (2026-10-07, `darwin-arm64`, Osen 0.1.0, 3 model calls); `codex` 0.159.2 `interface` (2026-10-16, `darwin-arm64`, Osen 0.9.0).

Merge, per pair (`agent`, `version`): the higher level wins, then the later `checkedAt`, then the local entry. The local record can raise a built-in entry, never lower it.

A local file with any invalid entry (bad schema, a duplicate pair, a wrong version or date format, an unknown agent or level, `modelCalls` wrong for the level, a bad `sha256`) is rejected as a whole; so is an unreadable file (no permission). The built-in record then applies, and the reason (the file name and the first invalid field, or the error code; no paths, no `sha256` values) is appended to the warning of every CLI provider and logged once per file state in `logs/app.log`. Nothing breaks: discovery, the provider listing and a session start continue.

Reading never creates or changes files. `cli-verified.json` is written only through `addLocalEntry` (by `council cli candidates`, the app's daily candidate check and `council cli accept`): the same schema, an atomic write, a refusal to overwrite a damaged file, the level of a pair is raised without duplicates. A changed file takes effect on the next CLI lookup, also in a running MCP server or app (the lookup cache is keyed by the file's state).

Warnings for the version reported by `--version`, by level: `real` — none; `interface` — "the interface is verified, a real acceptance run is missing"; not recorded — "newer" or "older" than the recorded range of this agent (for example `2.1.288–2.1.288`), or "not in the verified record" when it lies between recorded versions or none are recorded; undeterminable — "could not determine". Warnings never block a provider or a launch. `council providers` and `council doctor` show the level of each found CLI provider: [docs/cli.md, "The `council` command"](cli.md#the-council-command).

## CLI transition reminder (`cli-reminder.json`)

The app reminds the owner to move a CLI to a newer verified version, but never switches by itself. The state lives in `<data folder>/cli-reminder.json`, outside `cli/` (that folder is created only by `council cli install`):

```json
{ "schemaVersion": 1, "periodDays": 30,
  "lastCheck": { "at": "2026-10-20T12:00:00Z",
    "candidates": [ { "agent": "claude", "version": "2.1.302", "status": "violates", "recorded": false,
                      "violations": [ { "code": "missing_flag", "name": "--tools" } ] } ],
    "failures": [] } }
```

- `periodDays` — the planned transition period, an integer from 1 to 365 (30 by default). A pin older than this and a newer `real` version in the record make the "time for the planned transition" reminder.
- `lastCheck` — `null` or the last attempt of the candidate check: `at` (UTC, whole seconds), `candidates[]` and `failures[]` in the shape of `council cli candidates --json`. The outcome is stored as a code (`source_unavailable`, `install_failed`, `record_failed`, `no_base`, `check_failed`), never as text, so the file does not depend on the interface language.
- Unknown fields and values out of range make the file damaged.

When the file exists: only by saving the period in "Settings" or by the first candidate check of an agent that has an active Osen pin. Reading (opening "Settings", the window state) never creates it; neither do `council` commands and sessions. Writes are atomic (a temporary file, then a rename); an existing read-only file is respected and the old bytes stay.

A damaged file (not JSON, wrong schema, unreadable) is never overwritten by a check: the check does not run, "Settings" names the file and the reason, and the period shown is 30. Only saving the period replaces it (the last check is then lost).

Daily candidate check. The app runs it at start and then hourly, but a check actually runs only if at least 24 hours have passed since the last attempt, failed attempts included (a failure is recorded with its code and one error line in `logs/app.log`, and is not retried earlier). If `cli-reminder.json` cannot be written, the card shows "Check result not saved" with the error code and the time; the file path goes only to `logs/app.log`, not to the window. It covers only CLIs with an active Osen pin (PATH and explicit-path CLIs are not checked), uses the 180 candidate check (installation into a temporary prefix that is removed, interface check, `interface` entries in `cli-verified.json`), makes no model calls and never installs anything into `cli/` or changes `pins.json`.

Actions on the "Providers" tab of "Settings":

- "Switch to <version>" — the newest installed `real` version newer than the active pin whose install is intact (the executable is in place and its sha256 equals `pins.json`, the same check as before a launch); a recorded install that fails it gets the line "Installation <version> is damaged" with the code `missing` or `sha256_mismatch` (no path) and neither a switch button nor an install command; "Roll back" — the previous pin. Both call `council cli use` / `council cli rollback` logic (176) after a confirmation that names the versions, says that only new launches change and that no model is called. Without a confirmation nothing is written.
- They are unavailable while any session runs (the journal does not record the CLI version, so a switch under a running session would change the binary under the same journal); main checks this again before the call and refuses with a reason.
- Nothing happens automatically: the reminder only shows. A newer `real` version that is not installed is shown as the command `council cli install <agent> --version <version>` with a copy button; the app does not install it.

## Interface language

Two languages: English and Русский. English by default. The language is chosen in the "Language" block on the "Settings" screen and applies immediately, without a restart. Order of sources: the `COUNCIL_LANG` variable (`en` or `ru`) → the `preferences.json` file in the data folder → English. The variable can also be set in the data folder's `.env`; while it is set, the choice in the app is unavailable, and the block says so. If the data folder is unavailable (moving the former `model-council` folder failed), the refusal "Data folder is unavailable" from `council`, the MCP server and in the app's startup error window is printed in the language of the process environment's `COUNCIL_LANG`, otherwise in English; `preferences.json` and `.env` of the unavailable folder are not read in that case. The `council` command and the MCP server take the language at startup. For now the app shell and the "Settings", "Discussion", "New discussion", "Session setup" and "Discussion template" screens are shown in the chosen language, together with the app's refusals on those screens; the output, the `--help` help and the refusals of the `council` command and all its subcommands are printed in the language determined at startup before argument parsing (even a flag error); there is no separate language flag, the help names the source of the language; exit codes, commands, flags, identifiers and numbers are the same in both languages, model replies and what is recorded in the log are not translated. The MCP server gives instructions, tool descriptions and response texts in the same language; the remaining screens are translated by the next changes in the queue. The material name "Solution of the previous session <date>", the "(copy)" suffix and the name of a scripted participant are recorded in the language at the moment of creation and are not translated after the language changes.

The language of requests to models is the session language: it is fixed at creation from the current language (from the app, `council` or MCP) and does not change on resume, participant replacement or language change. In this language the engine assembles the protocol rules, section headings, the turn log, the correction request and the CLI participant's system prompt; the topic, materials, messages and model replies are passed as they are, and the language of the model's reply is not specified. Sessions created before this version are Russian. Check without cost (real `council` processes, scripted participants, 0 model calls):

```bash
COUNCIL_DEV=1 COUNCIL_HOME="$(mktemp -d "$PWD/.council-data-session-language-XXXXXX")" node packages/core/scenarios/session-language/check.ts
```

Check without cost (real main modules and the `council` process, 0 model calls); `--seed-only` prepares the data folder for the app window:

```bash
COUNCIL_DEV=1 COUNCIL_HOME="$(mktemp -d "$PWD/.council-data-language-XXXXXX")" node apps/desktop/scenarios/language/check.ts
COUNCIL_DEV=1 COUNCIL_HOME="$(mktemp -d "$PWD/.council-data-language-XXXXXX")" node apps/desktop/scenarios/language/check.ts --seed-only
```

## Appearance

The app theme is stored in `appearance.json` in the data folder: `{ "mode": "dark" | "light" | "system", "lightTheme": "tuman" | "len" | "inei" | "pergament" }`. Defaults: `dark` and `tuman`. Only the desktop app reads it; `council`, the MCP server and `preferences.json` are not affected (the theme has its own file because `writeLanguage` rewrites `preferences.json` whole).

Effective theme: `dark` gives `osen`; `light` gives the chosen light theme; `system` gives `osen` when macOS appearance is dark, otherwise the light theme. Changing the mode never changes the chosen light theme.

- A missing file means the defaults. The file is not created at startup; it is written atomically (temp file and rename) only when the owner changes the theme.
- A read-only file is respected: the change is refused with a reason in the interface language, the theme and the file stay unchanged.
- An unreadable file, invalid JSON or a value that is not an object gives defaults for both fields; an unknown value of one field gives the default for that field only. In both cases one warning line with the reason goes to `logs/app.log`, startup is not blocked, and the file is not rewritten until the owner chooses a theme.
- The "Appearance" section of Settings arrives with change 147; until then the theme is changed by editing the file or through the bridge action `setAppearance`.

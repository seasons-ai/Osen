# Participants

## CLI participants

Every turn is a new CLI process in an empty temporary folder: no tools, MCP servers, user instructions, hooks or skills, and no agent session persistence. The request goes through stdin, and the process gets `COUNCIL_PARTICIPANT=1`. Flags are checked against the help of the installed version; if the isolation flag is missing, the provider is unavailable. For `codex`, isolation is also confirmed by the `codex features list` output: if the list could not be read or lacks at least one disableable feature (`shell_tool` and the others from `CODEX_ISOLATION_FEATURES` in `packages/core/src/cli-agents/args.ts`), `codex` is unavailable, the reason names the version and the missing names, and a run with it is rejected before any model call; otherwise each of these features is disabled with the `--disable` flag. A check without cost is `COUNCIL_DEV=1 node packages/core/scenarios/codex-isolation/check.ts` (a `codex` stub). The command is also found with a minimal `PATH`. The app does not install, update or sign in to the CLI.

| Failure | What happens |
|---|---|
| command not found | the participant drops out, no retry |
| not signed in | the participant drops out, no retry |
| subscription limit exhausted (with the reset time, if the CLI reported it) | the participant drops out, no retry |
| timeout | one retry |
| non-zero exit code | one retry |

### Pinned install check before launch

A provider whose CLI comes from an active pin (`council cli install`, see [Pinned CLIs](cli.md#pinned-clis)) is launched only if the file on disk is still the file that was installed. The check compares, in this order, and stops at the first mismatch:

1. path: the path this provider would launch equals the path of the active install in `pins.json`;
2. file: the pinned file exists and is executable;
3. sha256: the checksum of the file equals the `sha256` recorded at install;
4. record level: the verified-versions record ([Verified CLI versions](data.md#verified-cli-versions-cli-verifiedjson)) has `real` for this version; `interface` or no entry is a mismatch;
5. version: `<binary> --version` prints the pinned version (an unreadable output is a mismatch too).

The binary is never run before step 5: a missing file, a different checksum or a record without `real` is rejected without starting it, not even for `--version`.

When it runs: at inspection (`council providers`, `council_options`, the provider list of the app, and the start of a session) and again before every turn, after re-reading `pins.json`. So a swap in the middle of a session is caught, and so is `council cli use` to another version: the turn is rejected before any process starts, the participant drops out by the usual rules with no retry, and no usage is written for the rejected turn.

What the owner sees: the provider is unavailable and the reason names the pin, the path and the mismatching values (both checksums, both versions, or the record level). It is the same text in `council providers`, the refusal of `council` and `council_start`, `council_options`, the app, the session feed and `council_status` after a dropout, and it ends with the way out: `council cli install`, or `council cli use` / `council cli rollback`.

There is no fallback: a failed check never launches the binary from `PATH`, another installed version, or another provider or model. An explicit `path` in `config.json` stays above the pin and is not checked; a provider without a pin keeps the earlier behavior (a warning about an unverified version, no refusal). A corrupted `pins.json` means "no active pin", with the warning described in [Pinned CLIs](cli.md#pinned-clis).

Cost: the sha256 of the whole file is computed once and cached by file identity (path, size, mtime, inode); an unchanged file is not hashed again, and before a turn only `stat` and `--version` run. Limit: a rewrite that leaves size, mtime and inode as they were is not seen; hashing on every turn would close this at the price of reading the whole binary each time.

A check without cost (stub CLIs, real `council` and MCP processes, no model calls): `COUNCIL_DEV=1 COUNCIL_HOME=<new folder inside the repository> node packages/core/scenarios/launch-guard/check.ts`. It prints one `ok -` line per step and exits non-zero if any step fails.

**CLI process environment.** A CLI process (`claude`, `codex`) does not get variables that come only from a `.env` file: from the `.env` in the current folder or from the data folder's `.env`, and are absent or empty in Osen's own environment. This keeps an API key meant for an HTTP provider (for example `OPENAI_API_KEY`) from switching a CLI from the subscription to paid API billing. Variables set in the shell pass as they are. The same filtering applies to the version and help reads, the candidate check, the acceptance probes, the turns, the app's start-up lookup and the detached executor of `council_start` (it reads `.env` itself, so HTTP providers still find their keys). HTTP providers keep reading keys from `.env`. Other `.env` variables (for example a proxy) do not reach the CLIs either: set them in the shell. A check without cost (stub CLIs, real `council` and MCP processes, a fake HTTP server, no model calls): `COUNCIL_DEV=1 node packages/core/scenarios/cli-key-env/check.ts`.

## HTTP participants

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

   `baseUrl` is the address up to `/chat/completions`, `http` or `https` only. `apiKeyEnv` is the name of the variable holding the key; the key itself is not in `config.json`, and a field containing it is rejected. For a local server without authorization, leave `apiKeyEnv` out. `models` holds only the models added by the owner; the list is always requested from the endpoint and merged with them. If the endpoint has no list, the provider stays available with the added models.

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

### Check without cost: fake server

```bash
node packages/core/src/http/fake-server.ts --port 8787
```

The server prints `Fake server: http://127.0.0.1:8787/v1` and runs until `Ctrl+C`. Flags: `--port` (8787 by default), `--api-key <value>` — require a key, `--chunk-delay <ms>` — the pause between stream chunks (150 by default). In a second terminal, add a keyless entry to `providers` in `.council-data/config.json`:

```json
{ "id": "fake", "kind": "openai-http", "label": "Fake", "models": [], "baseUrl": "http://127.0.0.1:8787/v1" }
```

and run:

```bash
COUNCIL_HOME=.council-data npx council providers
COUNCIL_HOME=.council-data npx council --topic "Как назвать кота" --participant fake:fake-amend --participant fake:fake-agree --max-rounds 2
```

Expected: a block `fake  openai-http  available  http://127.0.0.1:8787/v1` with the server's model list, then two turns and `══ Outcome: consensus`. The server's behavior is set by the model name: `fake-amend` proposes a solution, `fake-agree` agrees, `fake-auth` — authorization refused, `fake-rate` — rate limit exceeded, `fake-hang` — a hang (check with `--turn-timeout 2`), `fake-error` — a server error, `fake-midstream-error` — an error event with the numeric code 502 in the middle of the stream, `fake-midstream-rate` — an error event with the string code `rate_limit_exceeded` in the middle of the stream (recorded as a rate limit with one retry, like HTTP 429; the code `insufficient_quota` is treated the same), any other name — model not found.

A `baseUrl` with a login or password (`http://user:pass@host/v1`) makes the provider unavailable: `council providers` names the provider and the `baseUrl` field without echoing the address, and no request is sent to it. Remove the login and password from the address; the key is set by the `apiKeyEnv` variable.

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

Expected: a block `fake  openai-http  available  http://127.0.0.1:8787/v1` with the server's model list, then two turns and `══ Outcome: consensus`. The server's behavior is set by the model name: `fake-amend` proposes a solution, `fake-agree` agrees, `fake-auth` — authorization refused, `fake-rate` — rate limit exceeded, `fake-hang` — a hang (check with `--turn-timeout 2`), `fake-error` — a server error, any other name — model not found.

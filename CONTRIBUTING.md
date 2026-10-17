# Contributing

Osen is built for one owner, so outside changes are welcome but go through the same few rules the owner works by. Each rule below has a reason.

## An issue first, then a pull request

Open an issue before writing code: the conversation about *whether* and *how* belongs before the diff, not in its review. Say what you did, what happened, what you expected and the exact output — or, for a feature, the problem first and the proposed shape second.

The owner tracks agreed work as OpenSpec changes, which are kept outside this public tree. Reference the issue from your pull request; the owner links the change.

## Working on the code

Node 22.18 or newer. From the repository root:

```bash
npm install
npm run typecheck
npm test
```

`npm install` connects the hooks in `.githooks/`: `commit-msg` rejects a message outside the format below, and `pre-push` runs the type check and tests.

Tests and checks use `scripted` participants and make **zero model calls**. A change that needs a real `claude`, `codex` or HTTP provider to prove it is fine — say so in the pull request, and the owner runs that check with their own subscription. Never add a test that calls a real provider.

A new test must fail on the code without your change, then pass with it; a defect is first pinned by a failing test, then fixed. A test that cannot fail does not count.

## Pull requests

- Work on a branch; `main` accepts only pull requests, merged by squash.
- The title follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): description`. Squash merge turns it into the one commit on `main`, and the release reads it to pick the version and write `CHANGELOG.md` — see [docs/releases.md](docs/releases.md).
- The required checks are **Checks** (types, the full test suite, the desktop build) and **PR title**; every review conversation must be resolved.
- Fill in the template: the change, the commands you actually ran and their output, and the release impact.
- Do not bump the version, edit `CHANGELOG.md` or push tags: only `npm run release` does that, and only the owner runs it.

## What a change must not break

- The engine runs the discussion, not the models: turn order, the count of agreement and the end of a session are deterministic.
- Session state comes only from folding the event journal.
- `packages/core` depends on neither Electron nor MCP.
- A participant runs without tools, MCP servers or user instructions.
- The renderer process sees neither keys nor the file system.
- Lists of templates and models are data, not code.

## Language

Everything in git is in English: code, comments, test names, log lines, docs. Russian appears only as product text and its checks: the `ru` text catalogs, `templates/ru/`, and Russian input and expected output in tests.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

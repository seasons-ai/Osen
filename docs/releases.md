# Versions and releases

The product has a single version — `version` in `apps/desktop/package.json`, following [SemVer](https://semver.org/). Each released version has an annotated tag `vX.Y.Z` and a section in [CHANGELOG.md](../CHANGELOG.md). Versions and tags are not changed by hand.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): description`, where the scope is a change number or a part of the code.

| Type | When | Release level | CHANGELOG section |
|---|---|---|---|
| `feat` | new feature | minor | "Added" |
| `fix` | fix | patch | "Fixed" |
| `perf` | faster with no change in behavior | patch | "Performance" |
| `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert` | everything else | — | not included |
| `!` before the colon or `BREAKING CHANGE: …` in the body | incompatible (log, config, MCP) | major | "Breaking changes" |

The hooks in `.githooks/` are connected by `npm install` (the `prepare` script); in an already installed folder — `git config core.hooksPath .githooks`. `commit-msg` rejects a message that does not match the format; `pre-push` rejects a tag that does not match the version in `apps/desktop/package.json` and runs the type check and tests; a push of `change/*` branches only skips them, because `spec-dispatch` pushes those after the orchestrator's run and CI checks their pull requests. Before the tests it clears `GIT_DIR` and the other `GIT_*` variables git sets for hooks, so a test that runs git in a temporary repository cannot write to this one.

Changes go through a feature branch and a pull request. CI checks types, the full test suite and the desktop build; PR titles use Conventional Commits, checked by the separate `PR title` workflow on Linux. Squash merge keeps one semantic commit per PR. `main` requires passing CI and resolved conversations, with no external reviewer required for this single-owner project. Force pushes and branch deletion are blocked. GitHub security alerts and Dependabot update PRs cover dependency maintenance.

Releases have two stages. Start from clean `main` synchronized with `origin/main`:

```bash
git switch main
git pull --ff-only origin main
npm run release -- --dry-run
npm run release
```

Both commands refresh `origin/main` and refuse unsynchronized or dirty trees. The preview writes no files or tags. Preparation runs `typecheck` and the full test suite, creates `codex/release-vX.Y.Z`, updates the desktop version and lockfile, inserts the CHANGELOG section, and commits `chore(release): vX.Y.Z`. It does not tag or push. The level comes from commits after the latest reachable version tag; an explicit level/version is supported: `npm run release -- patch` (`minor`, `major` or `X.Y.Z`). For the initial public history without a reachable tag, the root commit is the baseline only if its desktop version matches the current version. Unrelated old local tags and history remain untouched.

Push the branch printed by the command and open a PR titled `chore(release): vX.Y.Z`. After successful CI, squash merge with that title; GitHub may append its `(#123)` PR number. Then publish its tag from synchronized main:

```bash
git switch main
git pull --ff-only origin main
npm run release -- publish
```

Publishing finds the latest release commit on main for the current desktop version, verifies its version, lockfile and first CHANGELOG section agree, and checks that the release commit contains only those three files. It creates an annotated `vX.Y.Z` tag on that release commit and pushes only that tag. Other PRs may already have advanced main; publishing still tags the validated release commit. A failed push can be retried; an existing tag must be annotated and point to the same commit. Never use `--follow-tags`: historical local tags are not part of this publishing flow.

The tag workflow verifies the release and main ancestry, runs checks, builds the arm64 DMG, validates its contents and creates a **draft** GitHub Release with the image, SHA256 checksums and CHANGELOG notes. Review and publish the draft explicitly. The existing ad hoc macOS signature is preserved; Apple notarization is not configured. Installation remains a separate owner-approved step in [docs/deploy.md](deploy.md), "Update".

To verify packaging without issuing a version, open **Actions → Release → Run workflow**, select **main**, keep **build_only** checked, and click **Run workflow**. This runs the same image checks and uploads a DMG/checksum artifact; it creates no version, tag or GitHub Release.

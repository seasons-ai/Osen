# Deploying on macOS

## What you get

A `.dmg` installer image and the `Osen` app in `/Applications`. The window title, the Dock name and the app menu name are "Osen"; the bundle identifier is `com.osen.desktop`. The build targets macOS on Apple Silicon (arm64) only. There is no developer signature and no notarization: the signature is ad-hoc and valid on this machine only. There is no auto-update.

## Prerequisites

- A Mac on Apple Silicon.
- Node 22.18 or later (the `engines` field in the root `package.json`).
- Installed dependencies:

```bash
cd "/Users/korat/Desktop/Мозговой штурм" && npm install
```

- Network access for the first build: a helper package of the image builder is downloaded once.

The version comes from the `version` field in `apps/desktop/package.json` (currently `0.9.0`). It ends up in the image name, in the app properties, in the interface and in the log.

## Build

1. Run the build (about a minute):

```bash
cd "/Users/korat/Desktop/Мозговой штурм" && npm run dist
```

2. The last line of the output is the path to the image: `/Users/korat/Desktop/Мозговой штурм/apps/desktop/release/osen-<version>-arm64.dmg`. The `apps/desktop/release/` folder is not tracked by git.

## Checking the image

1. Check the contents of the newest image:

```bash
cd "/Users/korat/Desktop/Мозговой штурм" && npm run dist:check
```

The check looks for the newest `osen-*.dmg` in `apps/desktop/release/`. To check a different image, pass its path: `npm run dist:check -- <path to .dmg>`.

2. Each check prints an `OK` or `FAIL` line: the image contains `Osen.app`, its `Info.plist` has the identifier `com.osen.desktop` and the display name `Osen`; `Contents/Resources` contains `icon.icns` and `CFBundleIconFile` points to it; the `GrantFileProtocolExtraPrivileges` fuse is off and `RunAsNode` is on (it runs PDF text extraction); the built-in templates are present; there are no `.env*` files; there is no `.council-data` and no `sessions`; there are no `*.pem`, `*.key`, `*.p12`; there is no `node_modules` inside the app; the secret values from the environment and from the repository `.env` do not appear in the image.
3. Exit code 0 means everything passed. On `FAIL`, do not install the image.

## App icon

The icon comes from `design/mockup-osen/brand/app-icon/`: `icon.icns` is for the bundle (`mac.icon` in `apps/desktop/electron-builder.yml`), `icon.png` is for the Dock of the development window (`npm run desktop`). There are no copies in `apps/desktop/`. To redraw the icon, replace the files in that folder and rebuild the image. If Finder or the Dock still show the old icon after an update, that is the macOS icon cache: restarting the Dock or logging out and back in clears it, and the owner does that.

## Install

The image contains `Osen.app` and an `Applications` shortcut. The name is in Latin letters: Electron does not start with Cyrillic in the bundle name.

Manually:

1. Open the `.dmg` by double-clicking it.
2. Drag `Osen` onto `Applications`.
3. Eject the image.

From the terminal:

```bash
hdiutil attach -nobrowse -readonly -mountpoint /tmp/osen-dmg "<path to .dmg>"
cp -R "/tmp/osen-dmg/Osen.app" /Applications/
hdiutil detach /tmp/osen-dmg
```

## First launch of an unsigned app

- An image built on this same machine is not quarantined: the app opens from Launchpad (the `Osen` icon) with an ordinary click, without warnings.
- An image from another Mac, or a downloaded one: macOS will not let you open the app with an ordinary click (not tested on this machine). Two ways:
  1. Try to open the app, then "System Settings" → "Privacy & Security" → the "Open Anyway" button at the bottom.
  2. Or in the terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Osen.app"
```

- From the terminal, launch it only by the full path. The command `open -a "Osen"` may open the copy from `apps/desktop/release/mac-arm64/` instead of the installed one.

```bash
open "/Applications/Osen.app"
```

## Check after installing

1. A window opened with the "History" screen.
2. At the bottom of the left rail (under the "New", "History", "Settings" items) there is a version number, for example `v0.1.0`.
3. "Settings": `claude` and `codex` are shown as found, with versions. An app started from Finder does not see the terminal `PATH` and finds the commands through the owner's login shell.
4. "New": 15 built-in templates are shown.
5. The participant picker has no "Scripted" provider: it appears only with `COUNCIL_DEV=1`.
6. The log has lines like `INFO [desktop] App start 0.1.0 (build), data folder: …` and one line for each provider found:

```bash
tail -n 20 "$HOME/Library/Application Support/osen/logs/app.log"
```

## Update

1. Complete the two-stage release procedure in README, "Versions and releases": `npm run release` prepares the version and CHANGELOG on a release branch; push it, squash merge its PR after CI, synchronize `main`, then run `npm run release -- publish` to publish its annotated tag. GitHub Actions builds and checks a DMG and creates a draft release. Review and publish that draft separately. App installation still requires the owner's approval.
2. Download the checked arm64 DMG and `SHA256SUMS` from the matching GitHub draft/release and verify its checksum with `shasum -a 256 -c SHA256SUMS`. To build locally, use a clean checkout of the published `vX.Y.Z` tag before running the following commands; do not package a main branch that has advanced beyond that tag under the released version:

```bash
cd "/Users/korat/Desktop/Мозговой штурм" && npm run dist && npm run dist:check
```

3. Keep the image of the current (old) version: you need it for a rollback. The images are in `apps/desktop/release/`; building a new version does not delete the old one.
4. Make a copy of the data folder:

```bash
src="$HOME/Library/Application Support/osen"; [ -d "$src" ] || src="$HOME/Library/Application Support/model-council"
cp -RL "$src" "$HOME/osen-backup-$(date +%Y%m%d-%H%M)"
```

   The first line takes `osen`, and if it does not exist yet (updating from a version where the folder was called `model-council`), takes `model-council`.

5. Quit the app (Cmd+Q).
6. Install the new image as in the "Install" section. When Finder asks about replacing, answer "Replace". From the terminal, delete the old app before `cp -R` (the data folder is not affected):

```bash
rm -rf "/Applications/Osen.app"
```

7. Launch the app, check the version number at the bottom of the rail and that the history is in place.
8. Compare the data folder with the copy (the `logs` folder is excluded: the log is appended to on every launch):

```bash
diff -r -x logs "<copy>" "$HOME/Library/Application Support/osen"
```

Empty output means nothing changed. Sessions started after the copy will show up in the output: that is normal.

### Updating from `Model Council.app` (versions before 0.8.0)

Since version 0.8.0 the app is called `Osen` and the bundle identifier is `com.osen.desktop`. Finder will not offer a replacement: the new bundle has a different name. At step 6, delete the old bundle and install the new one (the data folder is not affected):

```bash
rm -rf "/Applications/Model Council.app"
hdiutil attach -nobrowse -readonly -mountpoint /tmp/osen-dmg "<path to .dmg>"
cp -R "/tmp/osen-dmg/Osen.app" /Applications/
hdiutil detach /tmp/osen-dmg
env -i HOME="$HOME" USER="$USER" /usr/bin/open "/Applications/Osen.app"
```

- macOS treats `Osen` as a new app and asks for notification permission again: click "Allow". The setting is in "System Settings" → "Notifications" → `Osen`; the `Model Council` row stays there from the old bundle and has no effect.
- The Dock, Launchpad and the app menu show "Osen". If the old app's shortcut was pinned in the Dock, remove it manually.
- To roll back to a version before 0.8.0, delete `/Applications/Osen.app` and install the old image: the bundles have different names and do not replace each other.

### First launch of a version with `osen` over a version with `model-council`

Without `COUNCIL_HOME`, the first launch of the app (or of the MCP server or `council`) migrates the data by itself: a copy `model-council-backup-<YYYYMMDD-HHMMSS>` appears next to the folder, the `model-council` folder is renamed to `osen`, a `model-council` → `osen` link is left in its place, and a line about the move is written to `osen/logs/app.log`. Check:

```bash
ls -ld "$HOME/Library/Application Support/"{osen,model-council,model-council-backup-*}
grep -iE 'перенесена|moved' "$HOME/Library/Application Support/osen/logs/app.log"
```

If a session is running in the old folder, the migration is postponed: close it and start the app again. If both folders exist, `osen` is used (a warning in the log), and the folders are not merged.

After you have checked the new version, you can delete the link and the copy:

```bash
rm "$HOME/Library/Application Support/model-council"
rm -rf "$HOME/Library/Application Support/model-council-backup-"*
```

## Rollback to the previous version

1. Quit the app (Cmd+Q).
2. Install the previous version's image the same way as during the update (step 6).
3. Launch the app and check the version number.

A rollback does not touch the data folder. A version that looks for its data in `model-council` works after the migration through the `model-council` → `osen` link with the same history, so do not delete the link until you have checked the new version. If the link has already been deleted, create it again:

```bash
cd "$HOME/Library/Application Support" && ln -s osen model-council
```

The copy from step 4 of the update is needed only if the data is damaged: quit the app and put the copy back in place.

If there is no image of the previous version: restore the previous version number and code (`git checkout <commit>`), then build with `npm run dist`.

## Where the data and logs are

The data folder of the installed app: `~/Library/Application Support/osen` (the former `model-council` is migrated on first launch, see "Update"). The MCP server and the `council` command use the same folder when `COUNCIL_HOME` is not set.

| What | Where inside |
|---|---|
| Providers and defaults | `config.json` |
| Keys (created by the owner) | `.env` |
| History | `sessions/` |
| Custom templates | `templates/` |
| Log | `logs/app.log` |

Next to it there is Electron's service folder `~/Library/Application Support/osen-electron` (the window profile: cache, the lock against a second instance): it holds no discussion data. The development window (`npm run desktop`) writes its profile to `osen-electron-dev`; the `--user-data-dir=<folder>` flag sets your own folder. The former service folder `~/Library/Application Support/Мозговой штурм` (versions before 0.8.0) is not migrated and holds only the window cache; delete it if you like:

```bash
rm -rf "$HOME/Library/Application Support/Мозговой штурм"
```

Install, update and rollback replace only `/Applications/Osen.app` (when updating from a version before 0.8.0, also the old `/Applications/Model Council.app`).

## If something is wrong

`logs/app.log` records: the launch with the version, the providers found, every error (level `ERROR`), unhandled errors of the main process, and the exit of the window process.

- The line `ERROR [desktop] CLI codex: Command codex not found: it is neither in the process PATH nor in the login shell PATH; search locations: /usr/bin:/bin`:
  1. Open a new terminal window and run `which codex`.
  2. Restart the app.
  3. If that did not help, put the full path to the command in the `path` field of this provider in `config.json` and restart the app.
- The line `ERROR [desktop] Provider <id> unavailable: <reason>; search locations: <…>`: the provider is in the settings but unavailable. Fix the cause given in the line and restart the app.
- A check without model calls: development mode in the installed app (scripted participants, a separate data folder):

```bash
COUNCIL_DEV=1 COUNCIL_HOME=/tmp/council-check "/Applications/Osen.app/Contents/MacOS/Osen"
```

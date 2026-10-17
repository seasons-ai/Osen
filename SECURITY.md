# Security

Osen sends your files to model providers and runs their CLIs on your Mac. Its guarantees are about what those models and the app's own windows can reach: keys, your disk and your sessions. A way around any of them is a vulnerability.

**Do not open a public issue.** Report it privately: on the repository's [Security](https://github.com/seasons-ai/Osen/security) tab, press **Report a vulnerability**. Include:

- the steps, input or file that gets past the guarantee;
- what happens as a result;
- the commit or version (`apps/desktop/package.json`) and your macOS version.

The reply comes in the same private advisory. A fix is released as a patch, and the report is credited unless you ask otherwise.

## What counts

- A key from the data folder's `.env` reaching git, the session journal, logs or MCP responses.
- The renderer process reading keys or files on disk.
- A participant getting tools, MCP servers, user instructions or access to your disk, or reading a file beyond the text the engine sends it.
- The app, the `council` CLI or the MCP server deleting or overwriting an existing session, or writing to agents' global settings without `node skill/install.ts` being run.

## What does not

- Attached materials reaching the provider: they go into every turn by design, as [docs/materials.md](docs/materials.md) says.
- What a model writes in its turn — its arguments and solution are text, not commands.
- The image being unsigned and not notarized by Apple: documented in [docs/deploy.md](docs/deploy.md#first-launch-of-an-unsigned-app).

## Supported versions

The latest published [release](https://github.com/seasons-ai/Osen/releases). Until the first one is published, the current `main` branch.

// Check of provider models (change 244): a model added by the owner does not disable "Refresh models".
// Real main-process settings module with the real inspectProvider, and a real `council providers --json` process,
// against a local model-list server started by the stand. 0 model calls.
//   COUNCIL_DEV=1 node apps/desktop/scenarios/provider-models/check.ts
// Data folder: COUNCIL_HOME if set (must be new or empty), else .council-data/provider-models-<timestamp> inside the project,
// removed on success. Exit code 1 on any failed check.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { configPath, createLogger, ensureDataDir, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry } from "../../../../packages/core/src/index.ts";
import { setProcessLanguage } from "../../../../packages/core/src/i18n/index.ts";
import { inertTransition } from "../../src/main/cli-transition.testutil.ts";
import { createSettings } from "../../src/main/settings.ts";
import type { SettingsProvider } from "../../src/shared/settings.ts";

process.env["COUNCIL_LANG"] = "en";
setProcessLanguage("en");
if (process.env.COUNCIL_DEV !== "1") {
  console.error("Run: COUNCIL_DEV=1 node apps/desktop/scenarios/provider-models/check.ts");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const userHome = process.env.COUNCIL_HOME;
let dir: string;
if (userHome) {
  mkdirSync(resolve(userHome), { recursive: true });
  dir = realpathSync(resolve(userHome));
  if (readdirSync(dir).length) { console.error(`COUNCIL_HOME ${dir} is not empty: a new folder is needed.`); process.exit(2); }
} else {
  mkdirSync(join(repo, ".council-data"), { recursive: true });
  dir = realpathSync(mkdtempSync(join(repo, ".council-data", `provider-models-${Date.now()}-`)));
}

let failed = 0;
const check = (what: string, cond: boolean, detail: () => unknown) => {
  if (cond) console.log(`ok ${what}`);
  else { failed++; console.log(`FAIL ${what}: ${JSON.stringify(detail())}`); }
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Local model-list server; the list is switched by the stand.
let list = ["e1", "e2"];
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(req.url?.endsWith("/models") ? JSON.stringify({ object: "list", data: list.map((id) => ({ id, object: "model" })) }) : "{}");
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
const stopServer = () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); });

writeRegistry(ensureDataDir(dir), {
  providers: [{ id: "local", kind: "openai-http", label: "Local", baseUrl: `http://127.0.0.1:${port}/v1`, models: [] }],
  defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 60000, participants: [] },
} satisfies Registry);
const storedModels = () => (JSON.parse(readFileSync(configPath(dir), "utf8")) as Registry).providers[0]!.models;
const setStored = (models: string[]) => {
  const r = JSON.parse(readFileSync(configPath(dir), "utf8")) as Registry;
  r.providers[0]!.models = models;
  writeFileSync(configPath(dir), JSON.stringify(r, null, 2));
};

const env = { ...process.env, COUNCIL_HOME: dir };
const logger = createLogger(dir, "desktop", env);
const settings = createSettings({ dataDir: dir, env, reloadEnv: () => {}, logger, transition: inertTransition(dir, logger) });
const card = async (): Promise<SettingsProvider> => (await settings.view()).providers[0]!;
const pick = (p: SettingsProvider) => ({ available: p.available, models: p.models, ownerModels: p.ownerModels, modelsSource: p.modelsSource, modelsReason: p.modelsReason, modelsAt: p.modelsAt });

const run = promisify(execFile);
async function providersJson() {
  const { stdout } = await run(process.execPath, [join(repo, "packages/core/src/council.ts"), "providers", "--json"], { cwd: repo, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_HOME: dir, COUNCIL_LANG: "en" }, timeout: 60000 });
  return (JSON.parse(stdout) as { providers: { id: string; available: boolean; models: string[]; modelsConfirmed: boolean; modelsReason: string | null }[] }).providers.find((p) => p.id === "local")!;
}

try {
  let p = await card();
  check("app: endpoint list, nothing added", same(p.models, ["e1", "e2"]) && same(p.ownerModels, []) && p.modelsSource === "provider", () => pick(p));

  p = (await settings.saveModels("local", ["my-model"])).providers[0]!;
  check("app: after adding my-model config.json models is only [\"my-model\"]", same(storedModels(), ["my-model"]), storedModels);
  check("app: endpoint list and my-model shown, source by the request", same(p.models, ["e1", "e2", "my-model"]) && same(p.ownerModels, ["my-model"]) && p.modelsSource === "provider" && p.modelsAt !== null, () => pick(p));

  let c = await providersJson();
  check("council providers --json: list requested and merged with my-model", c.available && same(c.models, ["e1", "e2", "my-model"]) && c.modelsConfirmed, () => c);

  list = ["o1", "o2"];
  p = await settings.refreshModels("local");
  check("app: refresh with an added model requests the endpoint again", same(p.models, ["o1", "o2", "my-model"]) && p.modelsSource === "provider" && p.modelsAt !== null, () => pick(p));

  setStored(["o1", "o2", "legacy"]);
  p = await card();
  check("app: old config.json with the full list reads as added models", same(p.models, ["o1", "o2", "legacy"]) && same(p.ownerModels, ["o1", "o2", "legacy"]) && p.modelsSource === "provider", () => pick(p));
  p = (await settings.saveModels("local", [])).providers[0]!;
  check("app: \"Remove added models\" empties models and keeps the endpoint list", same(storedModels(), []) && same(p.models, ["o1", "o2"]) && same(p.ownerModels, []), () => ({ stored: storedModels(), ...pick(p) }));

  await settings.saveModels("local", ["my-model"]);
  await stopServer();
  p = await settings.refreshModels("local");
  check("app: endpoint down with an added model — available, my-model and the reason", p.available && same(p.models, ["my-model"]) && p.modelsSource === "unconfirmed" && /unreachable/i.test(p.modelsReason ?? ""), () => pick(p));
  c = await providersJson();
  check("council providers --json: endpoint down with an added model — available with the reason", c.available && same(c.models, ["my-model"]) && !c.modelsConfirmed && /unreachable/i.test(c.modelsReason ?? ""), () => c);
} catch (e) {
  failed++;
  console.log(`FAIL stand: ${e instanceof Error ? e.stack : String(e)}`);
} finally {
  if (server.listening) await stopServer();
}

if (failed) {
  console.log(`provider-models: ${failed} failed; data folder kept: ${dir}`);
  process.exit(1);
}
if (!userHome) rmSync(dir, { recursive: true, force: true });
console.log("provider-models: all checks passed, 0 model calls");

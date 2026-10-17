// Live check of change 114: when the data folder migration model-council -> osen fails, the refusal "Data folder is unavailable"
// is printed in the COUNCIL_LANG language of the environment by council, the MCP server and the app module (call order of
// apps/desktop/src/main/index.ts: loadEnv, applyProcessLanguage, prepareDataDir; the DataDirError text = the error window text).
//   COUNCIL_DEV=1 node packages/core/scenarios/language-env-data-dir/check.ts
//   … --seed-only — only prepare a fake HOME with a non-migratable legacy folder and print its path (for the window)
// The fake HOME is inside .council-data/language-env-data-dir-*; the owner's real data folder is not used.
// Child processes run with cwd in the stand's work folder: the repository root .env does not reach them. 0 model calls.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Usage: COUNCIL_DEV=1 node packages/core/scenarios/language-env-data-dir/check.ts");
  process.exit(1);
}
if (process.getuid?.() === 0) { console.error("The stand does not run as root: chmod 000 does not lock a file for root."); process.exit(1); }

const repo = resolve(import.meta.dirname, "../../../..");
const seedOnly = process.argv.includes("--seed-only");
mkdirSync(join(repo, ".council-data"), { recursive: true });
const workPath = join(repo, ".council-data", `language-env-data-dir-${Date.now()}-${randomBytes(3).toString("hex")}`);
mkdirSync(workPath, { recursive: true });
const work = realpathSync(workPath);
const support = (h: string) => join(h, "Library", "Application Support");
const locked: string[] = [];

// Fake HOME: a legacy folder with preferences.json (ru) and config.json.
function seed(name: string): { home: string; legacy: string; config: string } {
  const home = join(work, name);
  const legacy = join(support(home), "model-council");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "preferences.json"), `${JSON.stringify({ language: "ru" }, null, 2)}\n`);
  writeFileSync(join(legacy, "config.json"), "{}\n");
  return { home, legacy, config: join(legacy, "config.json") };
}
// config.json without permissions — the migration is bound to fail
const lock = (config: string) => { chmodSync(config, 0o000); locked.push(config); };

if (seedOnly) {
  const { home, config } = seed("window");
  lock(config);
  console.log(`Fake HOME: ${home}`);
  console.log(`Window: cd "${repo}" && env -u ELECTRON_RUN_AS_NODE -u COUNCIL_HOME COUNCIL_LANG=ru HOME="${home}" npm run desktop -- -- "--user-data-dir=<profile>"`);
  console.log(`Cleanup after the check: chmod 644 "${config}" && rm -rf "${work}"`);
  process.exit(0);
}

let total = 0;
let ok = 0;
function check(what: string, cond: unknown, detail = "") {
  total++;
  if (cond) { ok++; console.log(`OK   ${what}`); }
  else console.log(`FAIL ${what}${detail ? ` — ${detail.slice(0, 600).replace(/\s*\n\s*/g, " | ")}` : ""}`);
}

function childEnv(home: string, lang: string | undefined): Record<string, string> {
  if (!realpathSync(home).startsWith(work + "/") || home === homedir()) { console.error(`ABORT: HOME is outside the stand work folder: ${home}`); process.exit(2); }
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, COUNCIL_DEV: "1" };
  if (lang !== undefined) env.COUNCIL_LANG = lang;
  return env;
}
function run(args: string[], env: Record<string, string>, input?: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, args, { env, cwd: work, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const t = setTimeout(() => { child.kill("SIGKILL"); rej(new Error(`process ${args[0]} did not finish within 30 s\n${out}\n${err}`)); }, 30000);
    child.on("close", (code) => { clearTimeout(t); res({ code, out, err }); });
    child.stdin.on("error", () => undefined);
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

// sha256 of all files of the folder except logs/
function tree(dir: string): Record<string, string> {
  const res: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (rel.split("/")[0] === "logs") continue;
      if (e.isDirectory()) walk(p);
      else res[rel] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return res;
}

// The app module without a window: the same call order as in start() of apps/desktop/src/main/index.ts.
const coreUrl = pathToFileURL(join(repo, "packages/core/src/index.ts")).href;
const desktopProbe = join(work, "desktop-probe.ts");
writeFileSync(desktopProbe, `import { DataDirError, applyProcessLanguage, ensureDataDir, loadEnv, prepareDataDir } from ${JSON.stringify(coreUrl)};
const env = loadEnv(process.env, process.cwd());
applyProcessLanguage(env);
try { ensureDataDir(prepareDataDir(env)); console.log("OPENED"); }
catch (e) { if (!(e instanceof DataDirError)) throw e; console.log("DIALOG:" + e.message); process.exitCode = 1; }
`);

const RU = "Папка данных недоступна";
const EN = "Data folder is unavailable";
const init = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "check", version: "0" } } })}\n`;

async function main() {
  const { home, legacy, config } = seed("broken");
  const before = tree(legacy);
  lock(config);

  for (const lang of ["ru", "en", "de", undefined]) {
    const label = `COUNCIL_LANG=${lang ?? "(none)"}`;
    const ru = lang === "ru";
    const want = ru ? RU : EN;
    const other = ru ? EN : RU;
    const env = childEnv(home, lang);

    const c = await run([join(repo, "packages/core/src/council.ts"), "list"], env);
    const ca = c.out + c.err;
    check(`council list, ${label}: «${want}» with the legacy folder path, prefix ${ru ? "«Ошибка:»" : "«Error:»"}, code 1`, c.code === 1 && ca.includes(want) && !ca.includes(other) && ca.includes(ru ? "Ошибка:" : "Error:") && ca.includes(legacy), `code ${c.code}\n${ca}`);

    const m = await run([join(repo, "packages/mcp/src/main.ts")], env, init);
    check(`MCP server, ${label}: stderr «${want}», non-zero code, no responses`, m.code !== 0 && m.code !== null && m.err.includes(want) && !m.err.includes(other) && m.out.trim() === "", `code ${m.code}\nout: ${m.out}\nerr: ${m.err}`);

    const d = await run([desktopProbe], env);
    check(`app module, ${label}: error window text «${want}»`, d.code === 1 && d.out.includes(`DIALOG:${want}`) && !d.out.includes(other), `code ${d.code}\n${d.out}${d.err}`);
  }

  chmodSync(config, 0o644);
  const after = tree(legacy);
  check("the legacy folder is unchanged: sha256 of all files, including preferences.json, are equal", JSON.stringify(after) === JSON.stringify(before), `${JSON.stringify(before)}\n${JSON.stringify(after)}`);
  check("osen is not created, no backup and no lock", readdirSync(support(home)).join() === "model-council", readdirSync(support(home)).join());

  // Neighboring behavior: healthy permissions — the migration succeeds, the output is in the language of the variable.
  const okHome = seed("healthy").home;
  const r = await run([join(repo, "packages/core/src/council.ts"), "list"], childEnv(okHome, "ru"));
  const ra = r.out + r.err;
  check("healthy permissions, COUNCIL_LANG=ru: council list code 0, output in Russian, migration done", r.code === 0 && /[а-яё]/i.test(ra) && !ra.includes(RU) && existsSync(join(support(okHome), "osen", "preferences.json")), `code ${r.code}\n${ra}`);
}

let failed = false;
try { await main(); } catch (e) {
  failed = true;
  total++;
  console.log(`FAIL stand aborted: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
} finally {
  for (const f of locked) { try { chmodSync(f, 0o644); } catch {} }
}
console.log(`\nResult: ${ok} of ${total}`);
if (ok === total && !failed) {
  rmSync(work, { recursive: true, force: true });
  console.log("All checks passed, the work folder was deleted.");
  process.exit(0);
}
console.log(`There are failures. The work folder was kept: ${work}`);
process.exit(1);

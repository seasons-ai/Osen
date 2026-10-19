// Live check of machine output (change 139): real council processes, scripted participants only (0 model calls).
//   COUNCIL_DEV=1 node packages/core/scenarios/machine-output/check.ts
// Data folder: COUNCIL_HOME if set (must be new or empty), else .council-data/machine-output-<timestamp> inside the project,
// removed on success. Every spawned process gets COUNCIL_LANG explicitly.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Scripted participants are available only with COUNCIL_DEV=1. Run: COUNCIL_DEV=1 node packages/core/scenarios/machine-output/check.ts");
  process.exit(1);
}
const repo = resolve(import.meta.dirname, "../../../..");
const councilTs = join(repo, "packages/core/src/council.ts");
const scen = (p: string) => join(repo, "packages/core/scenarios", p);
const userHome = process.env.COUNCIL_HOME;
let work: string;
if (userHome) {
  mkdirSync(resolve(userHome), { recursive: true });
  work = realpathSync(resolve(userHome));
  if (readdirSync(work).length) { console.error(`COUNCIL_HOME ${work} is not empty: a new folder is needed.`); process.exit(1); }
} else {
  mkdirSync(join(repo, ".council-data"), { recursive: true });
  work = realpathSync(mkdtempSync(join(repo, ".council-data", `machine-output-${Date.now()}-`)));
}
const home = join(work, "home");
mkdirSync(home, { recursive: true });

let failed = 0;
const ok = (what: string) => console.log(`ok ${what}`);
const fail = (what: string, detail: string) => { failed++; console.log(`FAIL ${what}: ${detail.replace(/\s*\n\s*/g, " | ").slice(0, 600)}`); };
function check(what: string, cond: unknown, detail: () => string = () => "condition is false") { cond ? ok(what) : fail(what, detail()); }
async function group(name: string, fn: () => Promise<void> | void) {
  try { await fn(); } catch (e) { fail(name, e instanceof Error ? e.message : String(e)); }
}

type Lang = "en" | "ru";
const envFor = (h: string, lang: Lang) => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_DEV: "1", COUNCIL_HOME: h, COUNCIL_LANG: lang });
function run(args: string[], o: { lang?: Lang; home?: string } = {}) {
  const r = spawnSync(process.execPath, [councilTs, ...args], { env: envFor(o.home ?? home, o.lang ?? "en"), cwd: repo, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 90000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const dump = (r: { out: string; err: string }) => `stdout=${JSON.stringify(r.out.slice(0, 200))} stderr=${JSON.stringify(r.err.slice(0, 200))}`;
const uuid = (s: string) => /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(s)?.[0] ?? "";
const parseOne = (out: string): any => {
  if (!out.endsWith("\n") || out.slice(0, -1).includes("\n")) throw new Error(`stdout is not exactly one line: ${JSON.stringify(out.slice(0, 200))}`);
  return JSON.parse(out);
};
const sessionCount = (h = home) => (existsSync(join(h, "sessions")) ? readdirSync(join(h, "sessions")).length : 0);
const parts = (...ps: string[]) => ps.flatMap((p) => ["--participant", `scripted:${scen(p)}`]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// a command that must print one JSON document and exit 0
function json(what: string, args: string[], o: { lang?: Lang; home?: string } = {}) {
  const r = run([...args, "--json"], o);
  if (r.code !== 0) throw new Error(`${what}: code ${r.code} ${dump(r)}`);
  return { doc: parseOne(r.out), ...r };
}

let C = "", N = "";
const TOPIC = "Цена и тарифы";

await group("step 1", () => {
  const consensus = [...parts("consensus/p1.json", "consensus/p2.json"), "--max-rounds", "3"];
  const a = run(["--topic", TOPIC, ...consensus]), b = run(["--topic", TOPIC, ...consensus]);
  const n = run(["--topic", TOPIC, ...parts("no-consensus/p1.json", "no-consensus/p2.json", "no-consensus/p3.json"), "--max-rounds", "2"]);
  check("setup: two consensus runs exit 0", a.code === 0 && b.code === 0, () => `${a.code}/${b.code} ${dump(a)}`);
  check("setup: no_consensus run exits 3", n.code === 3, () => `${n.code} ${dump(n)}`);
  C = uuid(a.out); N = uuid(n.out);
  check("setup: session ids found", C && N, () => "no ids in output");
});

await group("step 2", () => {
  const en = json("list en", ["list"], { lang: "en" }), ru = json("list ru", ["list"], { lang: "ru" });
  check("list --json: one document, schemaVersion 1, 3 sessions", en.doc.schemaVersion === 1 && en.doc.sessions?.length === 3, () => JSON.stringify(en.doc).slice(0, 300));
  check("list --json: stderr empty", en.err === "" && ru.err === "", () => `${en.err}|${ru.err}`);
  check("list --json: topic is complete free text", en.doc.sessions.every((s: any) => s.topic === TOPIC), () => JSON.stringify(en.doc.sessions.map((s: any) => s.topic)));
  check("list --json: stdout byte-equal on en and ru", en.out === ru.out, () => `${en.out.slice(0, 150)} vs ${ru.out.slice(0, 150)}`);
});

await group("step 3", async () => {
  const sc = json("show consensus", ["show", C]).doc, sn = json("show no_consensus", ["show", N]).doc;
  check("show --json consensus: finish.status", sc.finish?.status === "consensus" && sc.status === "consensus", () => JSON.stringify(sc.finish));
  check("show --json no_consensus: finish.status and non-empty objecting", sn.finish?.status === "no_consensus" && sn.finish.objecting?.length > 0, () => JSON.stringify(sn.finish));
  const text = run(["show", C]).out;
  const solution = sc.currentVersion?.text;
  check("show --json consensus: decision text occurs in text show", typeof solution === "string" && solution.length > 0 && text.includes(solution), () => `text=${JSON.stringify(solution)}`);
  const st = json("status", ["status", C]).doc;
  check("status --json: round, maxRounds, turns numbers, waiting null", [st.round, st.maxRounds, st.turns].every((x: unknown) => typeof x === "number") && st.waiting === null, () => JSON.stringify(st));

  // a session that waits for the owner
  const child = spawn(process.execPath, [councilTs, "--topic", "Какой отчёт готовить к пятнице", ...parts("owner-wait/ask-p1.json", "owner-wait/answer-p2.json"), "--max-rounds", "3", "--wait-for-owner", "--owner-wait-sec", "60"], { env: envFor(home, "en"), cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number | null>((res) => child.on("close", res));
  try {
    let id = "", out = "";
    child.stdout!.on("data", (d) => { out += d; });
    let w: any = null;
    for (const t0 = Date.now(); Date.now() - t0 < 30000 && !w; await sleep(200)) {
      id ||= uuid(out);
      if (!id) continue;
      const r = run(["status", id, "--json"]);
      if (r.code === 0) w = parseOne(r.out).waiting;
    }
    check("status --json: waiting filled while the session waits for the owner", w !== null, () => "waiting stayed null for 30 s");
    if (w) {
      check("status --json waiting: waitId, reasons, questions, deadline", typeof w.waitId === "string" && w.reasons?.includes("owner_question") && w.questions?.length > 0 && typeof w.questions[0].text === "string" && typeof w.deadline === "string", () => JSON.stringify(w));
      const sh = json("show waiting", ["show", id]).doc;
      check("show --json: running session has finish null and waiting", sh.finish === null && sh.waiting?.waitId === w.waitId, () => JSON.stringify(sh.finish));
    }
    const stop = run(["stop", id]);
    check("stop of the waiting session exits 0", stop.code === 0, () => dump(stop));
    const code = await Promise.race([exited, sleep(60000).then(() => "timeout" as const)]);
    check("waiting session process exits after stop", code !== "timeout", () => "no exit in 60 s");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

await group("step 4", () => {
  const p = json("providers", ["providers"]);
  const textIds = run(["providers"]).out.split("\n").filter((l) => /^\S/.test(l)).map((l) => l.split(/\s+/)[0]);
  check("providers --json: ids equal the ids in text output", p.doc.schemaVersion === 1 && JSON.stringify(p.doc.providers.map((x: any) => x.id)) === JSON.stringify(textIds), () => `${JSON.stringify(p.doc.providers?.map((x: any) => x.id))} vs ${JSON.stringify(textIds)}`);
  const t = json("templates", ["templates"]);
  const textT = run(["templates"]).out;
  check("templates --json: ids appear in text output", t.doc.templates.length > 0 && t.doc.templates.every((x: any) => textT.includes(x.id)) && Array.isArray(t.doc.errors), () => JSON.stringify(t.doc).slice(0, 200));
  const l0 = json("lineups", ["lineups"]).doc;
  check("lineups --json: empty array on a fresh folder", Array.isArray(l0.lineups) && l0.lineups.length === 0, () => JSON.stringify(l0));
  const save = run(["lineups", "save", "n", "--from-session", C]);
  check("lineups save exits 0", save.code === 0, () => dump(save));
  const l1 = json("lineups after save", ["lineups"]).doc;
  check("lineups --json: saved lineup appears", l1.lineups.length === 1 && l1.lineups[0].name === "n" && l1.lineups[0].participants.length === 2, () => JSON.stringify(l1));
  const textL = run(["lineups"]).out;
  check("lineups --json: name appears in text output", textL.includes("n"), () => textL);
});

await group("step 5", () => {
  const before = sessionCount();
  const t = run(["doctor"]);
  check("doctor exits 0", t.code === 0 && t.out.length > 0, () => dump(t));
  const j = json("doctor", ["doctor"]);
  const d = j.doc, version = JSON.parse(readFileSync(join(repo, "apps/desktop/package.json"), "utf8")).version;
  check("doctor --json: binary.execPath and binary.version", d.schemaVersion === 1 && d.binary.execPath === process.execPath && d.binary.version === version, () => JSON.stringify(d.binary));
  check("doctor --json: runtime.mode node and node version", d.runtime.mode === "node" && d.runtime.node === process.versions.node, () => JSON.stringify(d.runtime));
  check("doctor --json: dataDir.path and config.path", d.dataDir.path === home && typeof d.config.path === "string" && d.config.path.startsWith(home), () => JSON.stringify([d.dataDir, d.config]));
  check("doctor --json: providers array", Array.isArray(d.providers) && d.providers.length > 0, () => JSON.stringify(d.providers));
  check("doctor creates no session", sessionCount() === before, () => `${before} -> ${sessionCount()}`);
  const ruText = run(["doctor"], { lang: "ru" });
  check("doctor text labels differ between en and ru", ruText.code === 0 && ruText.out !== t.out, () => "texts equal");
  // reason and warning are provider diagnostics in the interface language: compare only whether they are set
  const strip = (x: any) => { const { language, providers, ...rest } = x; return JSON.stringify({ ...rest, providers: providers.map((p: any) => ({ ...p, reason: p.reason === null, warning: p.warning === null })) }); };
  const ruJson = json("doctor ru", ["doctor"], { lang: "ru" }).doc;
  check("doctor --json equal on en and ru without language", strip(d) === strip(ruJson) && d.language !== ruJson.language, () => `${d.language}/${ruJson.language}`);
});

await group("step 6", () => {
  const refusal = (what: string, args: string[]) => {
    const r = run(args);
    check(`refusal: ${what}: code 2, stdout empty, stderr non-empty`, r.code === 2 && r.out === "" && r.err.trim() !== "", () => `code ${r.code} ${dump(r)}`);
  };
  const before = sessionCount();
  refusal("say --json", ["say", C, "x", "--json"]);
  refusal("launch --json", ["--json", "--topic", "x", ...parts("consensus/p1.json")]);
  check("refusal: launch --json created no session", sessionCount() === before, () => `${before} -> ${sessionCount()}`);
  refusal("lineups save --json", ["lineups", "save", "m", "--from-session", C, "--json"]);
  const names = run(["lineups", "--json"]);
  check("refusal: lineups save --json saved nothing", parseOne(names.out).lineups.length === 1, () => names.out);
  refusal("status unknown id --json", ["status", "no-such-id", "--json"]);

  const locked = mkdtempSync(join(work, "locked-"));
  try {
    chmodSync(locked, 0o000);
    let effective = false;
    try { mkdirSync(join(locked, "probe")); } catch { effective = true; }
    if (!effective) { console.log("skip inaccessible data folder: chmod 000 has no effect (running as root?)"); return; }
    const h = join(locked, "home");
    const doc = run(["doctor", "--json"], { home: h }), prov = run(["providers"], { home: h });
    check("inaccessible data folder: doctor --json code equals providers code (1), stdout empty", doc.code === 1 && prov.code === 1 && doc.out === "" && doc.err.trim() !== "", () => `doctor ${doc.code} ${dump(doc)} providers ${prov.code}`);
  } finally {
    chmodSync(locked, 0o755);
  }
});

await group("step 7", () => {
  const h = join(work, "home-ghost");
  mkdirSync(h, { recursive: true });
  writeFileSync(join(h, "config.json"), JSON.stringify({
    providers: [{ id: "ghost", kind: "cli", label: "Ghost", agent: "claude", path: join(work, "no-such-binary"), models: [] }],
    defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, participants: [] },
  }));
  const j = json("doctor ghost", ["doctor"], { home: h });
  const g = j.doc.providers.find((p: any) => p.id === "ghost");
  check("doctor --json: unavailable provider has available false and reason", g?.available === false && typeof g.reason === "string" && g.reason !== "", () => JSON.stringify(g));
  check("doctor --json: code 0, one document", j.code === 0 && j.doc.schemaVersion === 1);
});

if (failed === 0) {
  if (!userHome) rmSync(work, { recursive: true, force: true });
  console.log("ALL CHECKS PASSED");
} else console.log(`FAILED: ${failed} check(s); data folder kept: ${work}`);
process.exit(failed === 0 ? 0 : 1);

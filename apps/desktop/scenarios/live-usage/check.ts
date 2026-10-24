// Live check (change 240): token meter and top counter of the "Discussion" screen while a turn is running, on real council processes,
// the real core (readSession status) and main (historyRead), and the real renderer components (Participants.tsx bundled with esbuild).
//   COUNCIL_DEV=1 node apps/desktop/scenarios/live-usage/check.ts            (data folder: COUNCIL_HOME if given and empty, else .council-data/live-usage-check-*, removed on success)
//   ... --mutant   the bundled renderer gets a tokenUsage that ignores { live }: the stand MUST fail and name the incomplete mark during the running turn
// Participants are scripted: no model calls. Both languages (ru, en) are checked.
import "../../../../packages/core/scenarios/language-ru.ts";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import type { Plugin } from "esbuild";
import { ensureDataDir, readSession, tokenUsage, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry } from "../../../../packages/core/src/index.ts";
import type { SessionState } from "../../../../packages/core/src/protocol/index.ts";
import { historyRead } from "../../src/main/history.ts";
import { feed } from "../../src/shared/messages/session-feed.ts";

if (process.env.COUNCIL_DEV !== "1") { console.error("COUNCIL_DEV=1 is required"); process.exit(2); }
const mutant = process.argv.includes("--mutant");
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const own = !process.env.COUNCIL_HOME;
const home = process.env.COUNCIL_HOME ? resolve(process.env.COUNCIL_HOME) : join(root, ".council-data", `live-usage-check-${randomBytes(4).toString("hex")}`);
if (existsSync(home) && readdirSync(home).length > 0) { console.error(`${home} is not empty: use a new folder`); process.exit(2); }
mkdirSync(home, { recursive: true });
const dir = realpathSync(home);
const scen = join(root, "packages/core/scenarios");
let failed = 0;
const check = (name: string, cond: boolean, detail = "") => { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : detail ? ` (${detail})` : ""}`); if (!cond) failed++; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => T | false | undefined, ms = 60000): Promise<T> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(50)) { try { const v = fn(); if (v) return v; } catch { /* journal not yet readable */ } }
  throw new Error(`timed out waiting for: ${what}`);
}

// The renderer bundle: Participants.tsx together with its own copy of the i18n module, so the language is set in the same copy.
// Mutant: @model-council/core/protocol is replaced by a shim whose tokenUsage ignores the second argument.
const bundleDir = join(root, ".council-data", `live-usage-bundle-${randomBytes(4).toString("hex")}`);
mkdirSync(bundleDir, { recursive: true });
const entry = join(bundleDir, "entry.ts");
writeFileSync(entry, `export { ParticipantsPanel, RoundCounter } from ${JSON.stringify(join(root, "apps/desktop/src/renderer/src/Participants.tsx"))};
export { setProcessLanguage } from "@model-council/core/i18n";\n`);
const mutantPlugin: Plugin = {
  name: "mutant-token-usage",
  setup(b) {
    b.onResolve({ filter: /^@model-council\/core\/protocol$/ }, async (a) => {
      if (a.pluginData?.real) return undefined;
      const real = await b.resolve(a.path, { kind: a.kind, resolveDir: a.resolveDir, pluginData: { real: true } });
      return { path: real.path, namespace: "mutant-shim", pluginData: { real: real.path } };
    });
    b.onLoad({ filter: /.*/, namespace: "mutant-shim" }, (a) => ({
      contents: `export * from ${JSON.stringify(a.pluginData.real)};\nimport { tokenUsage as real } from ${JSON.stringify(a.pluginData.real)};\nexport const tokenUsage = (state) => real(state);\n`,
      resolveDir: dirname(a.pluginData.real), loader: "js",
    }));
  },
};
await build({
  entryPoints: [entry], outfile: join(bundleDir, "bundle.mjs"), bundle: true, format: "esm", platform: "node", jsx: "automatic", logLevel: "error",
  external: ["react", "react-dom", "react/jsx-runtime"], loader: { ".svg": "text", ".css": "empty" }, plugins: mutant ? [mutantPlugin] : [],
});
const ui = (await import(pathToFileURL(join(bundleDir, "bundle.mjs")).href)) as {
  ParticipantsPanel: never; RoundCounter: never; setProcessLanguage(l: "ru" | "en"): void;
};

type Lang = "ru" | "en";
function render(state: SessionState, running: boolean, lang: Lang): { panel: string; counter: string } {
  ui.setProcessLanguage(lang);
  // visible text of the markup: characters outside tags (a scan, not a tag-stripping regex)
  const text = (el: unknown) => {
    let out = "", inTag = false;
    for (const ch of renderToStaticMarkup(el as never)) {
      if (ch === "<") inTag = true;
      else if (ch === ">") inTag = false;
      else if (!inTag) out += ch;
    }
    return out;
  };
  return { panel: text(createElement(ui.ParticipantsPanel, { state, running })), counter: text(createElement(ui.RoundCounter, { state, running })) };
}

writeRegistry(ensureDataDir(dir), { providers: [], defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 1000, participants: [] } } satisfies Registry);
// A slow participant that reports tokens: a copy of result-usage/p3.json with a delay on every step.
const slowTokens = join(dir, "p3-slow.json");
const p3 = JSON.parse(readFileSync(join(scen, "result-usage/p3.json"), "utf8")) as { steps: Record<string, unknown>[] };
writeFileSync(slowTokens, JSON.stringify({ steps: p3.steps.map((s) => ({ delayMs: 4000, ...s })) }));

type Ev = { type: string; turn?: number; [k: string]: unknown };
type Run = { id: string; child: ChildProcess; closed: Promise<void> };
function startCouncil(p2: string): Run {
  const args = ["packages/core/src/council.ts", "--topic", "How to name the cat", "--max-rounds", "3", "--max-tokens", "1200",
    ...[join(scen, "result-usage/p1.json"), p2].flatMap((p) => ["--participant", `scripted:${p}`])];
  let out = "";
  const child = spawn(process.execPath, args, { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_DEV: "1", COUNCIL_HOME: dir } });
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const closed = new Promise<void>((r) => child.on("close", () => r()));
  return { id: "", child, closed, get out() { return out; } } as Run & { out: string };
}
const sessionId = async (r: Run) => { r.id = await until("council session id", () => /^Сессия (\S+) ·/m.exec((r as unknown as { out: string }).out)?.[1]); };
const evs = (id: string): Ev[] => readFileSync(join(dir, "sessions", id, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const turnOpen = (id: string, turn: number) => { const e = evs(id); return e.some((x) => x.type === "turn_started" && x.turn === turn) && !e.some((x) => (x.type === "turn_completed" || x.type === "turn_failed") && x.turn === turn); };
const turnDone = (id: string, turn: number) => evs(id).some((x) => x.type === "turn_completed" && x.turn === turn);
async function stop(r: Run) { // only the child this stand spawned, by its handle
  await Promise.race([r.closed, sleep(30000)]);
  if (r.child.exitCode === null && r.child.signalCode === null) { r.child.kill("SIGKILL"); await r.closed; }
}
const snap = (id: string) => { const s = readSession(dir, id)!; return { state: s.state, status: s.status }; };

const wantMeter = (lang: Lang) => feed(lang).countOf(500, 1200);
const mark = (lang: Lang) => feed(lang).incompleteCount.trim();
const TOK = (lang: Lang, v: string) => feed(lang).tokensShort(v);
const live: Run[] = [];
try {
  // Scenario A: the second participant is slow and reports no tokens.
  const a = startCouncil(join(scen, "owner-message/p2.json")); live.push(a);
  await sessionId(a);
  await until("turn 2 (slow p2) running", () => turnOpen(a.id, 2));
  let s = snap(a.id);
  check("A: status is running during the slow turn", s.status === "running", s.status);
  check("A: one finished call with 500 tokens", s.state.turns.length === 1 && tokenUsage(s.state).total === 500, String(tokenUsage(s.state).total));
  for (const lang of ["ru", "en"] as const) {
    const r = render(s.state, s.status === "running", lang);
    check(`A running turn [${lang}]: meter shows "${wantMeter(lang)}"`, r.panel.includes(wantMeter(lang)), r.panel);
    check(`A running turn [${lang}]: no incomplete mark in the participants column`, !r.panel.includes(mark(lang)), r.panel);
    check(`A running turn [${lang}]: top counter has "${TOK(lang, "500")}"`, r.counter.includes(TOK(lang, "500")), r.counter);
    check(`A running turn [${lang}]: top counter has no "≥"`, !r.counter.includes("≥"), r.counter);
  }
  await until("turn 2 finished", () => turnDone(a.id, 2));
  s = snap(a.id);
  for (const lang of ["ru", "en"] as const) {
    const r = render(s.state, s.status === "running", lang);
    check(`A after the turn without tokens [${lang}]: incomplete mark in the column`, r.panel.includes(mark(lang)), r.panel);
    check(`A after the turn without tokens [${lang}]: "≥" in the counter`, r.counter.includes("≥"), r.counter);
  }
  await stop(a);

  // Scenario B: the slow participant reports tokens: no mark during the turn and after it.
  const b = startCouncil(slowTokens); live.push(b);
  await sessionId(b);
  await until("turn 2 (slow p3) running", () => turnOpen(b.id, 2));
  s = snap(b.id);
  for (const lang of ["ru", "en"] as const) {
    const r = render(s.state, s.status === "running", lang);
    check(`B running turn [${lang}]: "${wantMeter(lang)}" and no mark`, r.panel.includes(wantMeter(lang)) && !r.panel.includes(mark(lang)), r.panel);
    check(`B running turn [${lang}]: counter without "≥"`, !r.counter.includes("≥"), r.counter);
  }
  await until("turn 2 finished", () => turnDone(b.id, 2));
  s = snap(b.id);
  check("B: both finished calls reported tokens", tokenUsage(s.state).total >= 1000, String(tokenUsage(s.state).total));
  for (const lang of ["ru", "en"] as const) {
    const r = render(s.state, s.status === "running", lang);
    check(`B after the turn [${lang}]: no mark, counter without "≥"`, !r.panel.includes(mark(lang)) && !r.counter.includes("≥"), `${r.panel} | ${r.counter}`);
  }
  await stop(b);

  // Scenario C: the executor dies mid-turn: interrupted, the mark stays everywhere.
  const c = startCouncil(slowTokens); live.push(c);
  await sessionId(c);
  await until("turn 2 (slow p3) running", () => turnOpen(c.id, 2));
  c.child.kill("SIGKILL");
  await c.closed;
  s = await until("status interrupted", () => { const x = snap(c.id); return x.status === "interrupted" ? x : false; });
  check("C: the session is interrupted, not running", s.status === "interrupted", s.status);
  check("C: tokenUsage(state) without live is incomplete (Result screen)", tokenUsage(s.state).incomplete === true);
  const row = historyRead(dir, new Map(), new Set()).items.find((i) => i.id === c.id);
  check("C: History row is interrupted with tokensIncomplete", row?.status === "interrupted" && row.tokensIncomplete === true, JSON.stringify(row && { st: row.status, inc: row.tokensIncomplete }));
  for (const lang of ["ru", "en"] as const) {
    const r = render(s.state, s.status === "running", lang);
    check(`C interrupted [${lang}]: incomplete mark and "≥"`, r.panel.includes(mark(lang)) && r.counter.includes("≥"), `${r.panel} | ${r.counter}`);
  }
} catch (err) {
  check("stand ran without exceptions", false, (err as Error).message);
} finally {
  for (const r of live) if (r.child.exitCode === null && r.child.signalCode === null) { r.child.kill("SIGKILL"); await r.closed; }
  rmSync(bundleDir, { recursive: true, force: true });
}
if (failed) { console.log(`FAILED: ${failed} check(s); data folder kept: ${dir}`); process.exit(1); }
console.log("ALL PASS");
if (own) rmSync(dir, { recursive: true, force: true });
process.exit(0);

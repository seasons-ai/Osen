// Stand for change 261: the setup remembers the roster of the newest desktop session cheaply and waits for it before opening.
//   COUNCIL_DEV=1 node apps/desktop/scenarios/last-roster/check.ts
//       400 fixture journals (~200 KiB each) + one newest desktop session (claude + scripted); the real `lastRoster` must return that
//       roster, read no more than the first line plus one block of every other journal (a node:fs byte counter), and be at least
//       2 times faster than the previous approach (listSessions(...).find(origin === "desktop")). Without COUNCIL_HOME the folder is
//       .council-data/last-roster-check-* and is removed on success; with COUNCIL_HOME it must be new or empty and is kept.
//   COUNCIL_DEV=1 COUNCIL_HOME=<new folder> node apps/desktop/scenarios/last-roster/check.ts --seed-only
//       prepares the same folder for the app window and prints the window command
//   node apps/desktop/scenarios/last-roster/check.ts --cdp <port> --main-inspect <port> [--delay-ms 1500]
//       drives the open window: "New discussion" → "Custom topic" shows the two remembered participants; then, with the bridge call
//       lastParticipants delayed in the main process (its IPC handler is wrapped through the main inspector, `npm run desktop -- --inspect <port>`),
//       the setup is absent and "Checking providers" is shown until the answer, then the same two participants.
//       Exit code 3 and "NOT VERIFIED" when the main handler cannot be wrapped.
// Model calls: 0 (scripted participants only).
import { randomUUID } from "node:crypto";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const argv = process.argv.slice(2);
const arg = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1]! : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PORT = 9361;
const JOURNALS = 400, TAIL_BYTES = 200 * 1024, BLOCK = 4096;
const REMEMBERED = [{ providerId: "claude", model: "claude-stand-model" }, { providerId: "scripted", model: "consensus/p1.json" }];

let failures = 0, n = 0;
const check = (ok: boolean, what: string, got?: unknown) => {
  n++;
  if (ok) console.log(`ok ${n}: ${what}`);
  else { failures++; console.log(`✗ ${n}: ${what}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`); }
};
const finish = (): never => {
  console.log(failures ? `RESULT: ${failures} of ${n} checks failed` : `RESULT: all ${n} checks passed`);
  process.exit(failures ? 1 : 0);
};

// ---------- CDP (as in setup-registry-return/check.ts) ----------
type Cdp = { send: (method: string, params?: object) => Promise<any>; close: () => void };
async function connect(ws: string): Promise<Cdp> {
  const sock = new WebSocket(ws);
  await new Promise((ok, fail) => { sock.onopen = ok; sock.onerror = fail; });
  let id = 0;
  const wait = new Map<number, (m: any) => void>();
  sock.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (typeof m.id !== "number") return;
    const done = wait.get(m.id);
    wait.delete(m.id);
    if (typeof done === "function") done(m);
  };
  return {
    send: (method, params = {}) => new Promise((ok, fail) => {
      const k = ++id;
      wait.set(k, (m) => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
      sock.send(JSON.stringify({ id: k, method, params }));
    }),
    close: () => sock.close(),
  };
}
async function pageTarget(port: number): Promise<string> {
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const page = list.find((t) => t.type === "page" && !t.url.startsWith("devtools:"));
  if (!page) throw new Error(`no page on port ${port}`);
  return page.webSocketDebuggerUrl;
}
// The main process (electron-vite dev --inspect <port>): a Node inspector target.
async function mainTarget(port: number): Promise<string> {
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { webSocketDebuggerUrl: string }[];
  if (!list[0]) throw new Error(`no main-process inspector on port ${port}`);
  return list[0].webSocketDebuggerUrl;
}
async function evaluate(cdp: Cdp, expression: string): Promise<any> {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
// Values reach the page as CDP call arguments, never spliced into code.
async function callIn(cdp: Cdp, fn: (...a: any[]) => unknown, ...args: unknown[]): Promise<any> {
  const self = await cdp.send("Runtime.evaluate", { expression: "globalThis" });
  const r = await cdp.send("Runtime.callFunctionOn", { functionDeclaration: fn.toString(), objectId: self.result.objectId, arguments: args.map((value) => ({ value })), awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

// ---------- CDP mode ----------
if (argv.includes("--cdp")) {
  const { newDiscussion } = await import("../../src/shared/messages/new-discussion.ts");
  const delayMs = Number(arg("--delay-ms") ?? 1500);
  const cdp = await connect(await pageTarget(Number(arg("--cdp"))));
  const waitFor = async (cond: string, what: string, ms = 15000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(60)) if (await evaluate(cdp, `Boolean(${cond})`).catch(() => false)) return;
    throw new Error(`timed out waiting for ${what}`);
  };
  const rail = async (i: number, ready: string) => {
    await callIn(cdp, (k: number) => (document.querySelectorAll(".rail__item")[k] as HTMLElement).click(), i);
    await waitFor(ready, `rail item ${i}`);
  };
  // Participant rows: the first select is the provider, the second is the model.
  const rows = (): Promise<{ providerId: string; model: string }[]> => callIn(cdp, () =>
    [...document.querySelectorAll(".setup-p")].map((p) => { const s = p.querySelectorAll("select"); return { providerId: s[0]!.value, model: s[1]!.value }; }));
  const toGallery = async () => {
    await rail(1, `!document.querySelector(".setup")`); // "History" drops the kept setup and remounts the flow
    await rail(0, `document.querySelector(".grid-cards button.card--dashed")`);
  };
  const customTopic = () => evaluate(cdp, `document.querySelector(".grid-cards button.card--dashed").click()`);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  const mainPort = arg("--main-inspect") === undefined ? undefined : Number(arg("--main-inspect"));
  let patched = false;
  let main: Cdp | undefined;
  try {
    const settings = await evaluate(cdp, "window.council.settings()") as { configPath: string };
    console.log(`window data folder: ${dirname(settings.configPath)}`);
    const lang = (await evaluate(cdp, "window.council.language()") as { language: "en" | "ru" }).language;
    const checking = newDiscussion(lang).checkingProviders;

    // A: no delay.
    await toGallery();
    await customTopic();
    await waitFor(`document.querySelector(".setup") && document.querySelectorAll(".setup-p").length === 2`, "the setup with two participants");
    check(same(await rows(), REMEMBERED), "setup opens with the two remembered participants", await rows());

    // B: lastParticipants answers late. The renderer bridge is frozen by contextBridge, so the delay is put on the main side:
    // through the main-process inspector the bridge IPC handler is wrapped to answer lastParticipants after delayMs.
    if (mainPort === undefined) {
      console.log("NOT VERIFIED: no --main-inspect <port>; the delayed variant was not run");
      cdp.close();
      process.exit(3);
    }
    main = await connect(await mainTarget(mainPort));
    // The delay reaches the main process as a call argument, never spliced into code.
    const g = await main.send("Runtime.evaluate", { expression: "globalThis" });
    await main.send("Runtime.callFunctionOn", { objectId: g.result.objectId, functionDeclaration: "function (ms) { globalThis.__stand261Delay = ms; }", arguments: [{ value: delayMs }] });
    const wrapped = await main.send("Runtime.evaluate", { includeCommandLineAPI: true, returnByValue: true, expression: `(() => {
      const handlers = require("electron").ipcMain._invokeHandlers;
      const orig = handlers?.get("council:call");
      if (typeof orig !== "function") return false;
      globalThis.__stand261 = orig;
      // The renderer asks registry() before lastParticipants(); the answer to lastParticipants waits for the registry answer
      // plus the delay, so the registry always arrives first. The flags let the stand look at the window between the two answers.
      const st = globalThis.__stand261State = { reg: Promise.resolve(), regDone: false, lastDone: false };
      handlers.set("council:call", async (e, action, args) => {
        if (action === "registry") {
          st.regDone = false;
          const p = Promise.resolve(orig(e, action, args));
          st.reg = p.then(() => { st.regDone = true; }, () => { st.regDone = true; });
          return p;
        }
        if (action !== "lastParticipants") return orig(e, action, args);
        st.lastDone = false;
        await st.reg;
        await new Promise((r) => setTimeout(r, globalThis.__stand261Delay));
        try { return await orig(e, action, args); } finally { st.lastDone = true; }
      });
      return true;
    })()` });
    if (wrapped.result?.value !== true) {
      console.log(`NOT VERIFIED: the main bridge handler cannot be wrapped (${JSON.stringify(wrapped.exceptionDetails?.text ?? wrapped.result)})`);
      main.close(); cdp.close();
      process.exit(3);
    }
    patched = true;
    await toGallery();
    await customTopic();
    const flags = async () => (await main!.send("Runtime.evaluate", { returnByValue: true, expression: "({ regDone: globalThis.__stand261State.regDone, lastDone: globalThis.__stand261State.lastDone })" })).result.value as { regDone: boolean; lastDone: boolean };
    for (const t0 = Date.now(); !(await flags()).regDone; await sleep(30)) if (Date.now() - t0 > 30000) throw new Error("timed out waiting for the registry answer");
    await sleep(Math.min(300, delayMs / 3)); // the window renders the registry answer
    const early = await callIn(cdp, (t: string) => ({ setup: Boolean(document.querySelector(".setup")), text: document.body.innerText.includes(t) }), checking) as { setup: boolean; text: boolean };
    const at = await flags();
    check(at.regDone && !at.lastDone, "the look happened after the registry answer and before the lineup answer", at);
    check(!early.setup && early.text, `before the answer: no setup, "${checking}" is shown`, early);
    await waitFor(`document.querySelector(".setup") && document.querySelectorAll(".setup-p").length === 2`, "the setup after the delay", delayMs + 10000);
    check(same(await rows(), REMEMBERED), "after the delay the same two remembered participants", await rows());
  } catch (e) {
    failures++;
    console.log(`✗ stand error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (patched && main) {
      await main.send("Runtime.evaluate", { includeCommandLineAPI: true, expression: `(() => { const h = require("electron").ipcMain._invokeHandlers; if (globalThis.__stand261) { h.set("council:call", globalThis.__stand261); delete globalThis.__stand261; delete globalThis.__stand261Delay; } })()` }).catch(() => {});
      main.close();
    }
    await callIn(cdp, () => (document.querySelectorAll(".rail__item")[1] as HTMLElement | undefined)?.click()).catch(() => {});
    cdp.close();
  }
  finish();
}

// ---------- seed ----------
const seedOnly = argv.includes("--seed-only");
if (process.env["COUNCIL_DEV"] !== "1" || (seedOnly && !process.env["COUNCIL_HOME"])) {
  console.error("COUNCIL_DEV=1 is required, and COUNCIL_HOME (a new empty folder) with --seed-only. Usage: COUNCIL_DEV=1 node apps/desktop/scenarios/last-roster/check.ts [--seed-only | --cdp <port>]");
  process.exit(2);
}
const given = process.env["COUNCIL_HOME"];
if (given && existsSync(resolve(given)) && (!statSync(resolve(given)).isDirectory() || readdirSync(resolve(given)).length > 0)) {
  console.error(`COUNCIL_HOME ${resolve(given)} already exists and is not empty: the stand writes only to a new folder.`);
  process.exit(2);
}
let dir: string;
if (given) { mkdirSync(resolve(given), { recursive: true }); dir = realpathSync(resolve(given)); }
else { mkdirSync(join(root, ".council-data"), { recursive: true }); dir = realpathSync(mkdtempSync(join(root, ".council-data", "last-roster-check-"))); }

// Count the bytes read per file through readSync and readFileSync BEFORE any module that reads journals is imported.
const reads = new Map<string, number>();
const fds = new Map<number, string>();
const add = (p: string | undefined, k: number) => { if (p !== undefined) reads.set(p, (reads.get(p) ?? 0) + k); };
const { openSync, readSync, readFileSync } = fs;
(fs as any).openSync = (...a: Parameters<typeof openSync>) => { const fd = openSync(...a); fds.set(fd, String(a[0])); return fd; };
(fs as any).readSync = (...a: Parameters<typeof readSync>) => { const k = readSync(...a); add(fds.get(a[0]), k); return k; };
(fs as any).readFileSync = (...a: Parameters<typeof readFileSync>) => { const r = readFileSync(...a); add(typeof a[0] === "number" ? fds.get(a[0]) : String(a[0]), Buffer.byteLength(r as string | Buffer)); return r; };
syncBuiltinESMExports();

const { ensureDataDir, listSessions, writeRegistry } = await import("../../../../packages/core/src/index.ts");
const { lastRoster } = await import("../../src/main/setup-data.ts");

const iso = (sec: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + sec * 1000).toISOString();
const session = (id: string, origin: "cli" | "desktop", createdAt: string, models: { providerId: string; model: string }[]) => ({
  id, createdAt, origin, topic: `fixture ${id}`, templateId: null, framing: "",
  participants: models.map((m, i) => ({ id: `p${i + 1}`, name: `n${i + 1}`, providerId: m.providerId, model: m.model, role: null })),
  limits: { maxRounds: 4, turnTimeoutSec: 60, contextChars: 1000 },
});
// session_created, then owner_message events (valid JSONL) up to about 200 KiB.
function writeJournal(id: string, s: ReturnType<typeof session>): { first: number; size: number } {
  const first = JSON.stringify({ seq: 1, ts: s.createdAt, type: "session_created", session: s, pid: 1 });
  const lines = [first];
  const text = "x".repeat(1000);
  for (let i = 1, bytes = 0; bytes < TAIL_BYTES; i++) {
    const l = JSON.stringify({ seq: i + 1, ts: s.createdAt, type: "owner_message", id: `o${i}`, text, afterTurn: 0, requestId: `r${i}` });
    lines.push(l);
    bytes += l.length + 1;
  }
  mkdirSync(join(dir, "sessions", id), { recursive: true });
  const body = `${lines.join("\n")}\n`;
  writeFileSync(join(dir, "sessions", id, "events.jsonl"), body);
  return { first: Buffer.byteLength(first), size: Buffer.byteLength(body) };
}

// Defaults (two "local" participants) differ from the remembered roster; the scripted provider needs no registry entry.
// The window only inspects "claude" (its version): no model call.
writeRegistry(ensureDataDir(dir), {
  providers: [
    { id: "claude", kind: "cli", label: "Claude", agent: "claude", models: ["claude-stand-model"] }, // the remembered provider must be known to the registry
    { id: "local", kind: "openai-http", label: "Local fake", baseUrl: "http://127.0.0.1:9/v1", models: ["fake-agree"] },
  ],
  defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 60000, participants: [{ providerId: "local", model: "fake-agree" }, { providerId: "local", model: "fake-agree" }] },
});
const others = [{ providerId: "scripted", model: "consensus/p2.json" }, { providerId: "scripted", model: "consensus/p2.json" }];
const sizes = new Map<string, { first: number; size: number }>();
for (let i = 0; i < JOURNALS; i++) {
  const id = randomUUID(); // random ids: name order is not time order
  sizes.set(id, writeJournal(id, session(id, i % 2 ? "cli" : "desktop", iso(i + 1), others)));
}
const chosen = randomUUID();
sizes.set(chosen, writeJournal(chosen, session(chosen, "desktop", iso(JOURNALS + 100), REMEMBERED)));
console.log(`Seeded ${sizes.size} journals in ${dir} (${[...sizes.values()].reduce((a, v) => a + v.size, 0) >> 20} MiB); newest desktop session ${chosen}`);

if (seedOnly) {
  console.log(`Window: cd "${root}" && COUNCIL_DEV=1 COUNCIL_HOME="${dir}" env -u ELECTRON_RUN_AS_NODE -u COUNCIL_LANG npm run desktop -- --remoteDebuggingPort ${PORT} --inspect ${PORT + 1} -- --user-data-dir="${dir}/profile"`);
  console.log(`Check: node apps/desktop/scenarios/last-roster/check.ts --cdp ${PORT} --main-inspect ${PORT + 1} --delay-ms 1500`);
  process.exit(0);
}

// ---------- default mode ----------
const path = (id: string) => join(dir, "sessions", id, "events.jsonl");
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const time = <T>(f: () => T, runs = 5) => { const ts: number[] = []; let r!: T; for (let i = 0; i < runs; i++) { const t0 = performance.now(); r = f(); ts.push(performance.now() - t0); } return { ms: median(ts), r }; };

reads.clear();
const roster = lastRoster(dir);
check(JSON.stringify(roster) === JSON.stringify(REMEMBERED), "lastRoster returns the roster of the newest desktop session", roster);
const chosenBytes = reads.get(path(chosen)) ?? 0;
check(chosenBytes >= sizes.get(chosen)!.size, `the byte counter works: the chosen journal read ${chosenBytes} of ${sizes.get(chosen)!.size} bytes`, chosenBytes);
let worst = 0, worstLimit = 0, over = 0;
for (const [id, v] of sizes) {
  if (id === chosen) continue;
  const got = reads.get(path(id)) ?? 0, limit = v.first + 1 + BLOCK;
  if (got > limit) over++;
  if (got > worst) { worst = got; worstLimit = limit; }
}
check(over === 0, `every other journal: at most the first line plus one block read (max ${worst} bytes, limit ${worstLimit}, over: ${over})`, over);

const fresh = time(() => lastRoster(dir));
const old = time(() => listSessions(dir).find((x) => x.origin === "desktop"), 3);
check(old.r?.id === chosen, "the previous approach finds the same session", old.r?.id);
const ratio = old.ms / fresh.ms;
console.log(`timing: lastRoster ${fresh.ms.toFixed(1)} ms (median of 5), listSessions().find ${old.ms.toFixed(1)} ms (median of 3), ratio ${ratio.toFixed(1)}x`);
check(ratio >= 2, `lastRoster is at least 2x faster than the previous approach (ratio ${ratio.toFixed(1)})`, ratio);

if (!failures && !given) rmSync(dir, { recursive: true, force: true });
else if (failures || given) console.log(`data folder kept: ${dir}`);
finish();

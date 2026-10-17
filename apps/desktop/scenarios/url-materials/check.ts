// Check of link materials on the real main-process modules (bridge, launcher, draft, preview, rerun) and the core, without an Electron window.
//   COUNCIL_DEV=1 COUNCIL_HOME="<new empty folder inside the project>" node apps/desktop/scenarios/url-materials/check.ts
//   ... --seed-only   prepare the folder for the window and keep the stand running: prints the COUNCIL_URL_STAND=<json> line and the window launch command; exits on SIGTERM/SIGINT
// The network is the UrlTransport seam (standTransport): name docs.stand.test -> 93.184.215.14 -> local HTTP port. The core rejects a loopback address; the address check is not replaced.
// Participants are scripted, 0 model calls. Writes only to COUNCIL_HOME and does not delete it.
// Mutation control (must fail): in materials.ts, in refresh(), before `if (roots.length === 0)` add
//   `void collectUrlMaterials(links.map((l) => l.url.href), { ...(deps.transport && { transport: deps.transport }) });`
// ("refresh() reloads the links") — the stand calls draft.refresh() and previewMaterials(…, true) and compares the number of transport requests.
import "../../../../packages/core/scenarios/language-ru.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_TEMPLATES_DIR, createLogger, ensureDataDir, loadTemplates, readMaterialSources, readRegistry, readSession, runStoredSession, writeRegistry } from "../../../../packages/core/src/index.ts";
import type { Registry } from "../../../../packages/core/src/index.ts";
import { createBridge } from "../../src/main/bridge.ts";
import { createLauncher } from "../../src/main/launcher.ts";
import { createMaterialsDraft } from "../../src/main/materials.ts";
import { previewMaterials } from "../../src/main/materials-preview.ts";
import { prepareRerun } from "../../src/main/rerun.ts";
import { createSettings } from "../../src/main/settings.ts";
import { standTransport } from "../../src/main/url-stand.ts";
import type { MaterialsPreviewView, MaterialsView, RerunView } from "../../src/shared/setup.ts";

const home = process.env.COUNCIL_HOME;
const seedOnly = process.argv.includes("--seed-only");
if (process.env.COUNCIL_DEV !== "1" || !home) {
  console.error("COUNCIL_DEV=1 and COUNCIL_HOME (a new empty folder inside the project) are required. Usage: COUNCIL_DEV=1 COUNCIL_HOME=<folder> node apps/desktop/scenarios/url-materials/check.ts");
  process.exit(2);
}
if (existsSync(resolve(home)) && (!statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0)) {
  console.error(`COUNCIL_HOME ${resolve(home)} already exists and is not empty: the script writes only to a new folder.`);
  process.exit(2);
}
mkdirSync(resolve(home), { recursive: true });
const dir = realpathSync(resolve(home));
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const scenDir = join(root, "packages/core/scenarios/consensus");
const env = { ...process.env, COUNCIL_DEV: "1", COUNCIL_HOME: dir };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (s: string) => console.log(`ok ${++n}: ${s}`);

writeRegistry(ensureDataDir(dir), {
  providers: [{ id: "inert", kind: "openai-http", label: "Не используется", baseUrl: "http://127.0.0.1:9", models: ["m"] }],
  defaults: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 24000, maxParticipants: 8, materialsIgnore: [], materialsChars: 5000, participants: [{ providerId: "inert", model: "m" }, { providerId: "inert", model: "m" }] },
} satisfies Registry);

// Local server: /doc, /slow, /missing; the /doc response is switched by a variable (check) or POST /__switch (serve)
let version = "first version";
const slowMs = seedOnly ? 5000 : 1500;
const page = (v: string) => `<html><head><title>Stand Page</title></head><body><h1>Stand Page</h1><p>${v}</p></body></html>`;
const server = http.createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const html = () => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(page(version)); };
  if (req.method === "POST" && path === "/__switch") { version = "second version"; res.writeHead(200); return void res.end("ok"); }
  if (path === "/doc") return html();
  if (path === "/slow") return void setTimeout(html, slowMs);
  res.writeHead(404); res.end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const tlog = join(dir, "url-transport.jsonl");
writeFileSync(tlog, "");
const standJson = JSON.stringify({ dns: { "docs.stand.test": ["93.184.215.14"] }, routes: { "93.184.215.14": port }, log: tlog });
const requests = (path?: string) => readFileSync(tlog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: string; host: string; path: string })
  .filter((e) => e.t === "request" && (path === undefined || e.path === path));

if (seedOnly) {
  console.log(`Data folder prepared: ${dir}`);
  console.log(`COUNCIL_URL_STAND=${standJson}`);
  console.log(`Addresses: https://docs.stand.test/doc?token=SECRET (fast), https://docs.stand.test/slow (${slowMs / 1000} s), https://docs.stand.test/missing (404). Switch the /doc response: curl -X POST http://127.0.0.1:${port}/__switch`);
  console.log(`Window: cd "${root}" && COUNCIL_DEV=1 COUNCIL_HOME="${dir}" COUNCIL_URL_STAND='${standJson}' env -u ELECTRON_RUN_AS_NODE npm run desktop -- --remoteDebuggingPort 9272 -- --user-data-dir="${dir}/profile"`);
  const stop = () => { server.closeAllConnections(); server.close(); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise(() => {}); // the stand keeps the server until a signal
}

// Real app modules
const logger = createLogger(dir, "desktop", env);
const draft = createMaterialsDraft({ transport: standTransport(standJson), limits: () => { const { materialsChars, materialsIgnore } = readRegistry(dir).defaults; return { materialsChars, materialsIgnore }; } });
const runs: Promise<unknown>[] = [];
const run: typeof runStoredSession = (o) => { const r = runStoredSession(o); runs.push(r); return r; };
const catalog = () => loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: join(dir, "templates") });
const launcher = createLauncher({ dataDir: dir, env, logger, materials: draft, registry: () => readRegistry(dir), catalog, scenarioPath: (m) => (m === "p1" || m === "p2" ? join(scenDir, `${m}.json`) : null), run });
const settings = createSettings({ dataDir: dir, env, reloadEnv: () => {}, logger, inspect: async (p) => ({ status: { id: p.id, kind: p.kind, label: p.label, available: false, reason: "не осматривается", models: [], modelsConfirmed: false } }) });
const stub = <T>(v: T) => () => v;
const bridge = createBridge({
  listSessions: stub([]), sessionExists: stub(false), watchSession: () => () => {}, notices: stub([]), listTemplates: stub({ templates: [], errors: [] }),
  registry: async () => ({}) as never, startSession: (input) => launcher.start(input), lastParticipants: stub(null), resumeOptions: async () => ({}) as never,
  resumeSession: async () => ({ droppedOwnerRequests: [] }), stopSession: () => {}, acceptVersion: () => ({}) as never, sendOwnerMessage: () => ({ requestId: "r" }), continueWait: () => ({ requestId: "r" }),
  previewMaterials: (refresh) => previewMaterials({ dataDir: dir, logger, materials: draft }, refresh), prepareRerun: (id, withDecision) => prepareRerun({ dataDir: dir, catalog, materials: draft }, id, withDecision), copyText: () => {},
  exportSession: async () => null, setPinned: () => {}, settings, templates: { open: stub(null), create: stub(null), save: stub(null), remove: () => {} } as never,
  materials: draft, pickMaterials: async () => null, send: () => {}, logger,
});
type R = { ok: true; value: unknown } | { ok: false; error: string };
const call = (a: string, ...args: unknown[]): Promise<R> => bridge.call(a, args);
async function good<T>(a: string, ...args: unknown[]): Promise<T> {
  const r = await call(a, ...args);
  assert.ok(r.ok, `${a}: success expected, got: ${r.ok ? "" : r.error}`);
  return r.value as T;
}
async function bad(what: string, a: string, ...args: unknown[]): Promise<string> {
  const r = await call(a, ...args);
  assert.ok(!r.ok, `${what}: a rejection was expected`);
  return r.error;
}
// An addUrl rejection arrives as a view with error; the list and the label stay unchanged
const refuse = async (what: string, url: string, was: MaterialsView): Promise<string> => {
  const v = await good<MaterialsView>("addUrl", url);
  assert.ok(v.error, `${what}: a rejection was expected`);
  assert.deepEqual({ ...v, error: null }, { ...was, error: null }, `${what}: the set changed`);
  return v.error;
};
const sessionsDir = join(dir, "sessions");
const two = [{ providerId: "scripted", model: "p1", role: null }, { providerId: "scripted", model: "p2", role: null }];
const newSession = async (extra: object) => {
  const r = await call("startSession", { templateId: null, topic: "Как назвать кота", participants: two, maxRounds: 3, useMaterials: true, ...extra });
  assert.ok(r.ok && (r.value as { id: string | null }).id !== null, `start: ${r.ok ? JSON.stringify(r.value) : r.error}`);
  const id = (r.value as { id: string }).id;
  await Promise.allSettled(runs);
  assert.ok(readSession(dir, id), "session created");
  return id;
};
const snap = (id: string) => readFileSync(join(sessionsDir, id, "materials", "m1.txt"), "utf8");
const logText = () => (existsSync(join(dir, "logs", "app.log")) ? readFileSync(join(dir, "logs", "app.log"), "utf8") : "");
const DOC = "https://docs.stand.test/doc?token=SECRET";
const check = (what: string, fn: () => void) => { try { fn(); } catch (e) { console.log(`FAIL ${n + 1}: ${what}: ${(e as Error).message}`); process.exit(1); } };

// 1. Adding
const v1 = await good<MaterialsView>("addUrl", DOC);
check("adding", () => {
  assert.equal(v1.items.length, 1);
  assert.equal(v1.items[0]!.source?.label, "docs.stand.test/doc");
  assert.ok(!JSON.stringify(v1).includes("SECRET"), "SECRET in the view");
  assert.ok(v1.items[0]!.chars > 0 && v1.chars === v1.items[0]!.chars, "the size is not counted in the total");
});
assert.ok(!logText().includes("SECRET"), "SECRET in app.log");
ok(`link added: row "${v1.items[0]!.source!.label}", size ${v1.chars} in the total, no query in the view or app.log`);

// 2. A load is in progress: the second is rejected
const before2 = await good<MaterialsView>("materials");
const slow = call("addUrl", "https://docs.stand.test/slow");
await sleep(400);
const busyErr = await refuse("second during loading", DOC, before2);
check("busy", () => assert.match(busyErr, /ещё загружается/));
const slowRes = await slow;
assert.ok(slowRes.ok, "the slow load failed");
const v2 = (slowRes as { value: MaterialsView }).value;
check("slow", () => { assert.equal(v2.items.length, 2); assert.equal(v2.items[1]!.source?.label, "docs.stand.test/slow"); });
ok("while /slow is loading, the second addUrl is rejected (\"ещё загружается\"), the set is unchanged; after loading the row appeared");

// 3. 404
const before3 = await good<MaterialsView>("materials");
const e404 = await refuse("404", "https://docs.stand.test/missing?x=1", before3);
check("404", () => {
  assert.match(e404, /404/);
  assert.ok(e404.includes("https://docs.stand.test/missing") && !e404.includes("x=1"), `reason: ${e404}`);
});
ok(`404 rejection: "${e404.replace(/\s+/g, " ")}", list and stamp unchanged`);

// 4. Loopback
const reqBefore = requests().length;
const eLoop = await refuse("loopback", `http://127.0.0.1:${port}/doc`, before3);
check("loopback", () => {
  assert.ok(eLoop.length > 0 && !/404/.test(eLoop));
  assert.equal(requests().length, reqBefore, "the transport received a request");
  assert.ok(!requests().some((r) => r.host.startsWith("127.0.0.1")), "the transport log has loopback");
});
ok(`loopback rejected by the core's address check ("${eLoop.replace(/\s+/g, " ").slice(0, 90)}"), no requests to the transport`);

// 5. Preview on one set: /slow removed, /doc remains
const v5 = await good<MaterialsView>("removeMaterial", "m2");
assert.equal(v5.items.length, 1);
const P0 = await good<MaterialsPreviewView>("previewMaterials", false);
draft.refresh();
const P = await good<MaterialsPreviewView>("previewMaterials", true);
await sleep(200);
check("preview", () => {
  assert.ok(P.initial?.includes("first version"), "initial without the page text");
  assert.equal(P.sources.length, 1);
  assert.ok(P.sources[0]!.url === "https://docs.stand.test/doc" && !JSON.stringify(P.sources[0]).includes("token") && !JSON.stringify(P.sources[0]).includes("SECRET"), JSON.stringify(P.sources[0]));
  assert.equal(P0.sources.length, 1);
  assert.equal(requests("/doc").length, 1, `refresh/preview update reloads the link: /doc requests ${requests("/doc").length}`);
  assert.equal(requests("/slow").length, 1);
});
ok(`preview: initial contains "first version", source "${P.sources[0]!.url}"; refresh() and the preview update added no requests`);

// 6. Server response changes, start from the accepted set
version = "second version";
const id1 = await newSession({ preparedHandle: P.handle });
const src1 = readMaterialSources(dir, id1);
check("start", () => {
  assert.ok(snap(id1).includes("first version") && !snap(id1).includes("second version"), "the snapshot is not from the accepted set");
  assert.equal(src1?.length, 1);
  assert.equal(src1![0]!.id, "m1");
  assert.equal(src1![0]!.host, "docs.stand.test");
  assert.equal(src1![0]!.pathname, "/doc");
  assert.equal(requests("/doc").length, 1, "the start reloaded the link");
});
ok("start from the set: snapshot \"first version\", sources.json with source m1, /doc requests still 1");

// 7. Start without preview (start 6 took the draft: the link is added again — a second /doc request, now with the second version)
await good<MaterialsView>("addUrl", DOC);
const id2 = await newSession({});
const src2 = readMaterialSources(dir, id2);
check("without preview", () => {
  assert.equal(src2?.length, 1);
  assert.ok(snap(id2).includes("second version"));
  assert.equal(requests("/doc").length, 2);
});
ok("start without preview: link added again (/doc requests 2), snapshot \"second version\", sources.json written");

// 8. Rerun with the server stopped
server.closeAllConnections();
await new Promise<void>((r) => server.close(() => r()));
const rr = await good<RerunView>("prepareRerun", id1, false);
check("rerun", () => {
  assert.equal(rr.materials.items.length, 1);
  assert.equal(rr.materials.items[0]!.source?.label, "docs.stand.test/doc");
});
const id3 = await newSession({ framingFrom: id1 });
const src3 = readMaterialSources(dir, id3);
check("start after rerun", () => {
  assert.ok(id3 !== id1 && src3?.length === 1 && src3[0]!.id === "m1" && src3[0]!.host === "docs.stand.test" && src3[0]!.pathname === "/doc");
  assert.ok(snap(id3).includes("first version"));
});
ok("rerun with the server stopped: row \"docs.stand.test/doc\", a new session with sources.json (m1)");

// 9. Request totals
check("request count", () => {
  assert.deepEqual([requests("/doc").length, requests("/slow").length, requests("/missing").length, requests().length], [2, 1, 1, 4]);
});
ok("network requests: /doc 2, /slow 1, /missing 1 — one per addUrl that reached the network (4 in total); start, preview, refresh and rerun added no requests");

console.log(`Result: ${n} checks, all passed; 0 real model calls; data folder ${dir}`);
process.exit(0);

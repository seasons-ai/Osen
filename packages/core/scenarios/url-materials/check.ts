// Check of URL materials with the real council CLI (local HTTP stand, scripted participants, 0 model calls):
//   COUNCIL_DEV=1 node packages/core/scenarios/url-materials/check.ts
// Writes only to a new folder <repository>/.council-data/url-check-*; deletes it on success, keeps it on failure.
import "../language-ru.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import { join, resolve } from "node:path";
import { assertResumedSource } from "./output.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Run: COUNCIL_DEV=1 node packages/core/scenarios/url-materials/check.ts");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
const wrapper = join(import.meta.dirname, "council-test.ts");
const prodEntry = join(repo, "packages/core/src/council.ts");
const work = join(repo, ".council-data", `url-check-${Date.now()}-${randomBytes(3).toString("hex")}`);
const home = join(work, "home"), scen = join(work, "scen"), tlog = join(work, "transport.jsonl");
for (const d of [home, scen]) mkdirSync(d, { recursive: true });
writeFileSync(tlog, "");
const QMARK = `QMARK${randomBytes(4).toString("hex")}`, TMARK = `TMARK${randomBytes(4).toString("hex")}`, SCRIPTMARK = `SCRIPTMARK${randomBytes(4).toString("hex")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ok = (s: string) => console.log(`ok ${++n}: ${s}`);
const kids = new Set<ReturnType<typeof spawn>>();
const captured: string[] = [];

// ---- local server ----
const hits: Record<string, number> = {};
let docVersion = "один";
const big = { early: false, written: 0 };
const sockets = new Set<Socket>();
const slowRes: http.ServerResponse[] = [];
let port = 0;
const server = http.createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  hits[path] = (hits[path] ?? 0) + 1;
  const text = (type: string, body: string) => { res.writeHead(200, { "content-type": type }); res.end(body); };
  const redirect = (to: string) => { res.writeHead(302, { location: to }); res.end(); };
  switch (path) {
    case "/doc":
      return text("text/html; charset=utf-8", `<html><head><title>Заголовок вкладки</title></head><body><h1>Стендовый документ</h1><p>Первый абзац версии ${docVersion}.</p><script>var x = "${SCRIPTMARK}";</script><img src="/img.png" alt="картинка"><p hidden>Скрытый текст.</p><p>Второй абзац версии ${docVersion}.</p></body></html>`);
    case "/plain": return text("text/plain; charset=utf-8", "Простой текст стенда: короткая заметка на русском языке.");
    case "/img.png": case "/secret": return text("text/plain", "не должно запрашиваться");
    case "/big": {
      res.writeHead(200, { "content-type": "text/plain" });
      res.on("close", () => { if (big.written < 4 * 2 ** 20) big.early = true; });
      const chunk = Buffer.alloc(65536, "a");
      const pump = () => {
        while (big.written < 4 * 2 ** 20 && !res.destroyed) {
          big.written += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      pump();
      return;
    }
    case "/slow": res.writeHead(200, { "content-type": "text/plain" }); res.write("начало"); slowRes.push(res); return;
    case "/loop": return redirect("/loop");
    case "/pdf": res.writeHead(200, { "content-type": "application/pdf" }); return void res.end("%PDF-1.4");
    case "/to-private4": return redirect("http://internal4.stand.test/secret");
    case "/to-private6": return redirect("http://[fd00::1]/secret");
    case "/to-loopback": return redirect(`http://127.0.0.1:${port}/secret`);
    default: res.writeHead(404); res.end();
  }
});
server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
port = (server.address() as { port: number }).port;

const stand = JSON.stringify({
  dns: { "docs.stand.test": ["93.184.215.14"], "internal4.stand.test": ["10.0.0.5"], "mixed.stand.test": ["93.184.215.14", "10.0.0.5"] },
  routes: { "93.184.215.14": port }, log: tlog,
});
const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_LANG: "ru", COUNCIL_DEV: "1", COUNCIL_HOME: home, URL_STAND: stand };

type Proc = { out: string; err: string; exited: Promise<number | null> };
function proc(entry: string, args: string[]): Proc {
  const child = spawn(process.execPath, [entry, ...args], { env, cwd: repo });
  kids.add(child);
  const r: Proc = { out: "", err: "", exited: new Promise((res) => child.on("close", (c) => { kids.delete(child); res(c); })) };
  child.stdout.on("data", (d) => { r.out += d; });
  child.stderr.on("data", (d) => { r.err += d; });
  r.exited.then(() => captured.push(r.out, r.err));
  return r;
}
const dump = (p: Proc) => `\n--- stdout ---\n${p.out}\n--- stderr ---\n${p.err}`;
async function exec(entry: string, args: string[]) { const p = proc(entry, args); const code = await p.exited; return { code, p }; }
const cli = (args: string[]) => exec(wrapper, args);
const prod = (args: string[]) => exec(prodEntry, args);

// ---- scenarios ----
type Step = { stance: string; solution?: string | null; expectPrompt?: string };
function scenario(name: string, steps: Step[]) {
  const path = join(scen, `${name}.json`);
  writeFileSync(path, JSON.stringify({ steps: steps.map(({ stance, solution, expectPrompt }) => ({
    ...(expectPrompt ? { expectPrompt } : {}),
    response: { stance, reasoning: "Проверка ссылок.", solution: solution ?? null, answers: [], questions: [] },
  })) }));
  return `scripted:${path}`;
}
const consensus = ["p1", "p2"].map((p) => `scripted:${join(repo, "packages/core/scenarios/consensus", `${p}.json`)}`);
const parts = (ps: string[]) => ps.flatMap((p) => ["--participant", p]);

// ---- reading ----
const url = (path: string, host = "docs.stand.test") => `http://${host}${path}?token=${QMARK}#${QMARK}`;
const sessionId = (p: Proc) => /^Сессия (\S+) ·/m.exec(p.out)?.[1] ?? assert.fail(`no “Сессия” line${dump(p)}`);
const sdir = (id: string) => join(home, "sessions", id);
const count = (d: string) => (existsSync(d) ? readdirSync(d).length : 0);
const counts = () => [count(join(home, "sessions")), count(join(home, "prepared-materials"))];
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const tlines = () => readFileSync(tlog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
function allFiles(d: string): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(d, e.name)) : [join(d, e.name)]));
}
async function refusal(label: string, args: string[], reason: string, safe: string, run = cli) {
  const before = counts();
  const r = await run(args);
  assert.equal(r.code, 2, `${label}: code ${r.code}${dump(r.p)}`);
  assert.ok(r.p.err.includes("Материалы не приняты:"), `${label}: no “Материалы не приняты:”${dump(r.p)}`);
  assert.ok(r.p.err.includes(`«${safe}»`), `${label}: no safe address${dump(r.p)}`);
  assert.ok(r.p.err.includes(reason), `${label}: no reason “${reason}”${dump(r.p)}`);
  assert.ok(!r.p.out.includes("Сессия "), `${label}: a session started${dump(r.p)}`);
  assert.deepEqual(counts(), before, `${label}: the number of sessions or sets changed`);
  return r;
}

async function main() {
  // ---- 1. Preview ----
  const r1 = await cli(["--url", url("/doc"), "--preview-materials"]);
  const o1 = r1.p.out;
  assert.equal(r1.code, 0, `code ${r1.code}${dump(r1.p)}`);
  for (const s of ["Стендовый документ", "Первый абзац версии один.", "Второй абзац версии один.", "Материалы: 1", "Источники ссылок: 1", "http://docs.stand.test/doc"]) assert.ok(o1.includes(s), `missing “${s}”${dump(r1.p)}`);
  for (const s of [SCRIPTMARK, "Скрытый текст", "Заголовок вкладки", "картинка"]) assert.ok(!o1.includes(s), `unexpected “${s}”${dump(r1.p)}`);
  const setId = /Подготовленный набор: ([0-9a-f]{32})/.exec(o1)?.[1] ?? assert.fail(`no set id${dump(r1.p)}`);
  assert.equal(hits["/doc"], 1); assert.equal(hits["/img.png"] ?? 0, 0);
  assert.equal(count(join(home, "sessions")), 0, "a session was created");
  const setDir = join(home, "prepared-materials", setId);
  for (const f of ["set.json", "set.sha256", "sources.json"]) assert.ok(existsSync(join(setDir, f)), `missing ${f}`);
  ok(`preview: code 0, text without script/hidden/title/alt, set ${setId}, no sessions, /doc once, /img.png 0`);

  // ---- 2. Start by the set after the document changes ----
  docVersion = "два";
  const E = "Первый абзац версии один.";
  const pair = (name: string) => [
    scenario(`${name}-p1`, [{ stance: "amend", solution: "Решение по документу.", expectPrompt: E }, { stance: "object", expectPrompt: E }, { stance: "agree", expectPrompt: E }]),
    scenario(`${name}-p2`, [{ stance: "object", expectPrompt: E }, { stance: "object", expectPrompt: E }, { stance: "agree", expectPrompt: E }]),
  ];
  const r2 = await cli(["--topic", "Что важно в документе", ...parts(pair("s2")), "--max-rounds", "1", "--prepared-materials", setId]);
  assert.equal(r2.code, 3, `code ${r2.code} (5 means the turn failed on expectPrompt)${dump(r2.p)}`);
  assert.ok(r2.p.out.includes(`Подготовленный набор: ${setId}`) && r2.p.out.includes("Источники ссылок: 1"), `summary${dump(r2.p)}`);
  assert.equal(hits["/doc"], 1, "repeated /doc download");
  const sid = sessionId(r2.p);
  const m1 = join(sdir(sid), "materials", "m1.txt");
  const m1Bytes = readFileSync(m1);
  assert.ok(m1Bytes.toString("utf8").includes("версии один") && !m1Bytes.toString("utf8").includes("версии два"), "m1.txt is not version “один”");
  const src = JSON.parse(readFileSync(join(sdir(sid), "materials", "sources.json"), "utf8"));
  const srcText = JSON.stringify(src);
  assert.ok(srcText.includes("docs.stand.test") && srcText.includes("/doc"), `sources.json: ${srcText}`);
  assert.ok(!/"(search|query)"/.test(srcText), `sources.json with query: ${srcText}`);
  const created = readFileSync(join(sdir(sid), "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.type === "session_created");
  const mat = created.session.materials[0];
  assert.deepEqual(Object.keys(mat).sort(), ["chars", "id", "name", "sha256"]);
  const setMat = JSON.stringify(JSON.parse(readFileSync(join(setDir, "set.json"), "utf8")));
  assert.equal(mat.sha256, sha(m1Bytes));
  assert.ok(setMat.includes(mat.sha256), "the material's sha256 is not in set.json");
  ok("start by the set after the document changed: code 3, participants saw version “один” (expectPrompt), /doc was not reloaded, snapshot and sha256 match");

  // ---- 3. Resume ----
  const r3 = await cli(["resume", sid, "--rounds", "2"]);
  assert.equal(r3.code, 0, `code ${r3.code}${dump(r3.p)}`);
  assert.ok(r3.p.out.includes("Источники ссылок: 1"), `sources${dump(r3.p)}`);
  const saved = src.sources[0];
  assert.deepEqual([src.sources.length, saved.id, saved.scheme, saved.host, saved.pathname], [1, "m1", "http", "docs.stand.test", "/doc"], `sources.json: ${srcText}`);
  assertResumedSource(r3.p.out, { id: "m1", url: "http://docs.stand.test/doc", fetchedAt: saved.fetchedAt });
  assert.equal(hits["/doc"], 1);
  assert.ok(readFileSync(m1).equals(m1Bytes), "m1.txt changed");
  ok("resume from the snapshot: code 0 (consensus), the one source row matches the saved m1 record, no network, m1.txt unchanged");

  // ---- 4. File and URL directly ----
  const note = join(scen, "note.md");
  writeFileSync(note, "# Заметка\nТекст заметки владельца.\n");
  const r4 = await cli(["--topic", "Файл и ссылка", "--attach", note, "--url", url("/plain"), ...parts(consensus), "--max-rounds", "3"]);
  assert.equal(r4.code, 0, `code ${r4.code}${dump(r4.p)}`);
  assert.ok(r4.p.out.includes("Материалы: 2"), `Материалы: 2${dump(r4.p)}`);
  assert.ok(r4.p.out.split("\n").some((l) => l.startsWith("  m2 ← http://docs.stand.test/plain")), `source line${dump(r4.p)}`);
  const sid4 = sessionId(r4.p);
  assert.ok(readFileSync(join(sdir(sid4), "materials", "m1.txt"), "utf8").includes("Текст заметки"));
  assert.ok(readFileSync(join(sdir(sid4), "materials", "m2.txt"), "utf8").includes("Простой текст стенда"));
  ok("file and URL directly: code 0, Материалы: 2, m1 is the note, m2 is the URL text");

  // ---- 5. Rejections ----
  await refusal("5a", ["--url", url("/big"), "--preview-materials"], "тело больше 2097152 байт", "http://docs.stand.test/big");
  await sleep(300);
  assert.ok(big.early && big.written < 4 * 2 ** 20, `5a: the client did not close early (early=${big.early}, written=${big.written})`);
  ok(`5a. /big: rejection “тело больше 2097152 байт”, the client closed the connection early (written ${big.written} of 4194304)`);

  const loopBefore = hits["/loop"] ?? 0;
  await refusal("5b", ["--url", url("/loop"), "--preview-materials"], "больше 3 перенаправлений", "http://docs.stand.test/loop");
  assert.equal((hits["/loop"] ?? 0) - loopBefore, 4, "5b: number of /loop requests");
  ok("5b. /loop: “больше 3 перенаправлений”, exactly 4 requests");

  await refusal("5c", ["--url", url("/pdf"), "--preview-materials"], "формат application/pdf не поддерживается", "http://docs.stand.test/pdf");
  ok("5c. /pdf: “формат application/pdf не поддерживается”");

  const t0 = Date.now();
  await refusal("5d", ["--topic", "Медленная ссылка", "--url", url("/slow"), ...parts(consensus), "--max-rounds", "3"], "не уложились в 15 с", "http://docs.stand.test/slow");
  const el = (Date.now() - t0) / 1000;
  assert.ok(el >= 14 && el <= 25, `5d: ${el} s`);
  ok(`5d. /slow, full start (the only slow check): “не уложились в 15 с”, ${el.toFixed(1)} s`);

  const r5e = await refusal("5e", ["--topic", "Две ссылки", "--url", url("/doc"), "--url", url("/pdf"), ...parts(consensus), "--max-rounds", "3"], "формат application/pdf не поддерживается", "http://docs.stand.test/pdf");
  assert.equal(r5e.p.err.split("\n").filter((l) => l.startsWith("  «")).length, 1, `5e: reason lines${dump(r5e.p)}`);
  ok("5e. two URLs (/doc and /pdf): code 2, one reason line (for /pdf), no session");

  // ---- 6. Internal addresses, the production builder ----
  const docBefore = hits["/doc"];
  for (const h of [`127.0.0.1:${port}`, `[::1]:${port}`, `localhost:${port}`]) {
    const r = await prod(["--url", `http://${h}/doc?token=${QMARK}`, "--preview-materials"]);
    assert.equal(r.code, 2, `${h}: code ${r.code}${dump(r.p)}`);
    assert.ok(r.p.err.includes("непубличный"), `${h}: no “непубличный”${dump(r.p)}`);
  }
  assert.equal(hits["/doc"], docBefore, "6: the server received a request");
  ok("production entry: 127.0.0.1, [::1], localhost — code 2 “непубличный”, server untouched");

  // ---- 7. Internal addresses behind a public name ----
  for (const p of ["/to-private4", "/to-private6", "/to-loopback"]) {
    await refusal(`7 ${p}`, ["--url", url(p), "--preview-materials"], "перенаправление на непубличный адрес", `http://docs.stand.test${p}`);
  }
  await refusal("7 mixed", ["--url", url("/doc", "mixed.stand.test"), "--preview-materials"], "непубличный", "http://mixed.stand.test/doc");
  assert.equal(hits["/secret"] ?? 0, 0);
  const tl = tlines();
  const bad = tl.filter((e) => e.t === "request" && ["10.0.0.5", "fd00::1", "127.0.0.1"].includes(e.address));
  assert.deepEqual(bad, [], "requests to internal addresses");
  assert.deepEqual(tl.filter((e) => e.t === "unrouted"), [], "unrouted");
  ok("redirects to 10.0.0.5, fd00::1, 127.0.0.1 and mixed DNS rejected, /secret 0, no requests to internal addresses");

  // ---- 8. A URL in the topic is not downloaded ----
  const docNow = hits["/doc"], resolves = tl.filter((e) => e.t === "resolve").length;
  const r8 = await cli(["--topic", `Обсудим http://docs.stand.test/doc?token=${TMARK}`, ...parts(consensus), "--max-rounds", "3"]);
  assert.equal(r8.code, 0, `code ${r8.code}${dump(r8.p)}`);
  assert.equal(hits["/doc"], docNow);
  assert.equal(tlines().filter((e) => e.t === "resolve").length, resolves, "DNS requests grew");
  assert.ok(!existsSync(join(sdir(sessionId(r8.p)), "materials")), "a materials folder appeared");
  ok("a URL in the topic is not downloaded: code 0, no requests, no name resolutions, no materials folder");

  // ---- 9. Leaks ----
  const files = [...allFiles(home), tlog];
  const hay = [...captured.map((c, i) => [`output #${i}`, c] as const), ...files.map((f) => [f, readFileSync(f, "utf8")] as const)];
  for (const [what, text] of hay) assert.ok(!text.includes(QMARK), `QMARK found: ${what}`);
  ok(`QMARK is neither in ${captured.length / 2} runs (stdout/stderr) nor in ${files.length} files (data folder and transport log)`);

  assert.equal(hits["/img.png"] ?? 0, 0); assert.equal(hits["/secret"] ?? 0, 0);
  console.log(`Total: all checks passed (${n})`);
}

const finish = () => { for (const k of kids) k.kill("SIGKILL"); for (const r of slowRes) r.destroy(); for (const s of sockets) s.destroy(); server.close(); };
const guard = setTimeout(() => { console.error(`FAILED: watchdog timer 150 s\nStand kept: ${work}`); finish(); process.exit(1); }, 150_000);
try {
  await main();
  clearTimeout(guard);
  finish();
  rmSync(work, { recursive: true, force: true });
} catch (e) {
  clearTimeout(guard);
  console.error(`FAILED: ${(e as Error).message}\nStand kept: ${work}`);
  finish();
  process.exit(1);
}

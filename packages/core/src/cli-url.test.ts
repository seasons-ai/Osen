import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT, help, main } from "./cli.ts";
import { sha256Of } from "./materials.ts";
import { eventsPath } from "./store/journal.ts";
import { preparedMaterialsDir, savePreparedMaterials } from "./store/prepared-materials.ts";
import type { UrlResponse, UrlTransport } from "./url/fetch.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(realpathSync(tmpdir()), "council-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const sc = (dir: string, file: string) => join(import.meta.dirname, "../scenarios", dir, file);
const sp = (dir: string, file: string) => `scripted:${sc(dir, file)}`;
const two = (dir = "consensus") => ["--participant", sp(dir, "p1.json"), "--participant", sp(dir, "p2.json")];
const topic = ["--topic", "Как назвать кота"];

const Q = "?token=SECRETMARK#SECRETMARK";
const PAGE = "https://h.test/page";
const HTML = "<h1>Заголовок страницы</h1><p>Первый абзац текста.</p><p>Второй абзац текста.</p><script>СКРИПТТЕКСТ()</script>";
type Reply = { status?: number; type?: string; body: string };

function fakeTransport(table: Record<string, Reply>) {
  const t = { table, resolves: 0, requests: 0, transport: undefined as unknown as UrlTransport };
  t.transport = {
    async resolve() { t.resolves++; return [{ address: "93.184.215.14", family: 4 }]; },
    async request(url): Promise<UrlResponse> {
      t.requests++;
      const r = t.table[url.pathname] ?? { status: 404, body: "" };
      return { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html; charset=utf-8" }, body: (async function* () { yield new TextEncoder().encode(r.body); })(), destroy() {} };
    },
  };
  return t;
}

async function run(argv: string[], over: { home?: string; t?: ReturnType<typeof fakeTransport> } = {}) {
  const home = over.home ?? tmp();
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, {
    stdout: (x) => out.push(x), stderr: (x) => err.push(x),
    env: { COUNCIL_HOME: home, COUNCIL_DEV: "1" },
    inspectDeps: { locate: async (agent) => ({ agent, found: false, searchPath: "", reason: `Команда ${agent} не найдена` }) },
    ...(over.t ? { urlTransport: over.t.transport } : {}),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), home };
}

const ls = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
const files = (dir: string): string[] => ls(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p]; });
const setId = (out: string) => /Подготовленный набор: ([0-9a-f]{32})/.exec(out)![1]!;
const sessionId = (out: string) => /^Сессия (\S+) ·/m.exec(out)![1]!;
const events = (home: string, id: string) => readFileSync(eventsPath(home, id), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const noSecret = (home: string) => { for (const f of files(home)) expect(readFileSync(f, "utf8"), f).not.toContain("SECRETMARK"); };

describe("council --url / --preview-materials / --prepared-materials", () => {
  it("1. preview: page text without script, source, set on disk, no sessions", async () => {
    const t = fakeTransport({ "/page": { body: HTML } });
    const r = await run(["--url", PAGE + Q, "--preview-materials"], { t });
    expect(r.code).toBe(0);
    for (const s of ["Заголовок страницы", "Первый абзац текста.", "Второй абзац текста.", "Источники ссылок: 1", `m1 ← ${PAGE} · получено `]) expect(r.out).toContain(s);
    expect(r.out).not.toContain("СКРИПТТЕКСТ");
    expect(r.out).toMatch(/Материалы: 1, объём \d+ символов/);
    const id = setId(r.out);
    expect(ls(join(r.home, "sessions"))).toEqual([]);
    expect(ls(join(preparedMaterialsDir(r.home), id)).sort()).toEqual(["set.json", "set.sha256", "sources.json"]);
  });

  it("2. secret from query and fragment appears nowhere", async () => {
    const t = fakeTransport({ "/page": { body: HTML } });
    const r = await run(["--url", PAGE + Q, "--preview-materials"], { t });
    expect(r.out + r.err).not.toContain("SECRETMARK");
    expect(files(r.home).some((f) => f.endsWith("app.log"))).toBe(true);
    noSecret(r.home);
  });

  it("3. launch from a set: network not used, snapshot and source saved", async () => {
    const t = fakeTransport({ "/page": { body: HTML } });
    const home = tmp();
    const pv = await run(["--url", PAGE + Q, "--preview-materials"], { home, t });
    const id = setId(pv.out);
    const set = JSON.parse(readFileSync(join(preparedMaterialsDir(home), id, "set.json"), "utf8"));
    t.table["/page"] = { body: "<p>Совсем другой текст.</p>" };
    const dir = tmp();
    for (const n of ["p1", "p2"]) {
      const s = JSON.parse(readFileSync(sc("consensus", `${n}.json`), "utf8"));
      s.steps[0].expectPrompt = "Первый абзац текста.";
      writeFileSync(join(dir, `${n}.json`), JSON.stringify(s));
    }
    const before = t.requests;
    const r = await run([...topic, "--participant", `scripted:${join(dir, "p1.json")}`, "--participant", `scripted:${join(dir, "p2.json")}`, "--max-rounds", "3", "--prepared-materials", id], { home, t });
    expect(r.code).toBe(0);
    expect(t.requests).toBe(before);
    const sid = sessionId(r.out);
    const mdir = join(home, "sessions", sid, "materials");
    expect(readFileSync(join(mdir, "m1.txt"), "utf8")).toBe(set.materials[0].text);
    expect(set.materials[0].text).toContain("Первый абзац текста.");
    expect(existsSync(join(mdir, "sources.json"))).toBe(true);
    const created = events(home, sid).find((e) => e.type === "session_created");
    expect(Object.keys(created.session.materials[0]).sort()).toEqual(["chars", "id", "name", "sha256"]);
    expect(created.session.materials[0].sha256).toBe(set.materials[0].sha256);
    noSecret(home);
  });

  it("4. materials limit taken from the set", async () => {
    const t = fakeTransport({ "/page": { body: HTML } });
    const home = tmp();
    const pv = await run(["--url", PAGE, "--preview-materials", "--materials-chars", "5000"], { home, t });
    const r = await run([...topic, ...two(), "--max-rounds", "3", "--prepared-materials", setId(pv.out)], { home, t });
    expect(r.code).toBe(0);
    expect(events(home, sessionId(r.out)).find((e) => e.type === "session_created").session.limits.materialsChars).toBe(5000);
  });

  it("5. resume: sources printed without network; corrupted sources.json does not interfere", async () => {
    const t = fakeTransport({ "/page": { body: HTML } });
    const seed = async (home: string) => {
      const r = await run([...topic, "--participant", sp("resume", "p1.json"), "--participant", sp("resume", "p2.json"), "--max-rounds", "2", "--url", PAGE + Q], { home, t });
      expect(r.code).toBe(3);
      return sessionId(r.out);
    };
    const home = tmp();
    const id = await seed(home);
    const snap = join(home, "sessions", id, "materials", "m1.txt");
    const bytes = readFileSync(snap);
    const requests = t.requests;
    const r = await run(["resume", id, "--rounds", "1"], { home, t });
    expect(r.out).toContain("Продолжение сессии");
    expect(r.out).toContain("Источники ссылок: 1");
    expect(r.out).toContain(`m1 ← ${PAGE} · получено `);
    expect(t.requests).toBe(requests);
    expect(readFileSync(snap).equals(bytes)).toBe(true);
    noSecret(home);
    const home2 = tmp();
    const id2 = await seed(home2);
    writeFileSync(join(home2, "sessions", id2, "materials", "sources.json"), "garbage");
    const bad = await run(["resume", id2, "--rounds", "1"], { home: home2, t });
    expect(bad.out).toContain("Источники ссылок: не удалось прочитать sources.json");
    expect(bad.out).toContain("══ Итог:");
  });

  it("6. --attach and --url: file m1, link m2", async () => {
    const t = fakeTransport({ "/page": { body: HTML } });
    const f = join(tmp(), "note.txt");
    writeFileSync(f, "Локальная заметка.");
    const r = await run([...topic, ...two(), "--max-rounds", "3", "--attach", f, "--url", PAGE + Q], { t });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Материалы: 2, объём");
    expect(r.out).toContain(`m2 ← ${PAGE} · получено `);
    expect(r.out).not.toContain("m1 ← ");
    expect(readFileSync(join(r.home, "sessions", sessionId(r.out), "materials", "m1.txt"), "utf8")).toBe("Локальная заметка.");
    noSecret(r.home);
  });

  it("7. one link refused: exit code 2, no session or set", async () => {
    for (const preview of [false, true]) {
      const t = fakeTransport({ "/ok": { body: HTML } });
      const argv = [...(preview ? [] : [...topic, ...two()]), "--url", "https://h.test/ok" + Q, "--url", "https://h.test/missing" + Q, ...(preview ? ["--preview-materials"] : [])];
      const r = await run(argv, { t });
      expect(r.code).toBe(2);
      expect(r.err.startsWith("Материалы не приняты:")).toBe(true);
      expect(r.err).toContain("https://h.test/missing");
      expect(r.err).toContain("ответ HTTP 404");
      expect(r.err).not.toContain("Использование:");
      expect(r.out).not.toContain("Сессия ");
      expect(ls(join(r.home, "sessions"))).toEqual([]);
      expect(ls(preparedMaterialsDir(r.home))).toEqual([]);
      noSecret(r.home);
    }
  });

  it("8. ambiguous flags: exit code 2, help, no network, no sessions", async () => {
    const id = "a".repeat(32);
    const u = ["--url", "https://h.test/x"];
    const cases: string[][] = [
      ["--prepared-materials", id, "--attach", "x"], ["--prepared-materials", id, ...u], ["--prepared-materials", id, "--materials-chars", "100"],
      ["--prepared-materials", id, "--preview-materials"], ["--preview-materials"], ["--preview-materials", ...u, "--topic", "x"],
      ["--preview-materials", ...u, ...two()], ["--preview-materials", ...u, "--max-rounds", "2"], ["--url", ""], ["--prepared-materials", ""],
      ["resume", id, ...u], ["list", ...u],
    ];
    for (const argv of cases) {
      const t = fakeTransport({});
      const r = await run(argv, { t });
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err, argv.join(" ")).toContain("Использование:");
      expect(r.err.startsWith("Ошибка: ")).toBe(true);
      expect(t.resolves + t.requests).toBe(0);
      expect(ls(join(r.home, "sessions"))).toEqual([]);
      expect(ls(preparedMaterialsDir(r.home))).toEqual([]);
    }
  });

  it("9. bad set: unknown, invalid, outdated, corrupted", async () => {
    const mk = (home: string, now?: () => Date) => savePreparedMaterials(home, { materials: [{ id: "m1", name: "a.txt", chars: 3, sha256: sha256Of("abc"), text: "abc" }], workspace: [], skipped: [], left: [], materialsChars: 1000, stamp: "t" }, now ? { now } : {});
    const home = tmp();
    const expired = mk(home, () => new Date(Date.now() - 25 * 3600 * 1000)).id;
    const corrupt = mk(home).id;
    writeFileSync(join(preparedMaterialsDir(home), corrupt, "set.sha256"), "garbage");
    const cases: [string, string][] = [["f".repeat(32), "не найден"], ["../sessions/x", "Недопустимый идентификатор"], [expired, "устарел"], [corrupt, "повреждён"]];
    for (const [id, why] of cases) {
      const r = await run([...topic, ...two(), "--prepared-materials", id], { home });
      expect(r.code, id).toBe(2);
      expect(r.err, id).toContain("Подготовленный набор не принят:");
      expect(r.err, id).toContain(why);
      expect(r.err).not.toContain("Использование:");
      expect(ls(join(home, "sessions"))).toEqual([]);
    }
  });

  it("10. link only in the topic is not loaded", async () => {
    const t = fakeTransport({ "/secret": { body: HTML } });
    const r = await run(["--topic", "Обсудим https://h.test/secret?token=SECRETMARK", ...two(), "--max-rounds", "3"], { t });
    expect(r.code).toBe(0);
    expect(t.resolves + t.requests).toBe(0);
    expect(r.out).not.toContain("Материалы:");
  });

  it("11. link text over the limit: exit code 2, no session", async () => {
    const t = fakeTransport({ "/page": { body: HTML } });
    const r = await run([...topic, ...two(), "--url", PAGE + Q, "--materials-chars", "10"], { t });
    expect(r.code).toBe(2);
    expect(r.err).toContain("лимит 10");
    expect(ls(join(r.home, "sessions"))).toEqual([]);
    noSecret(r.home);
  });

  it("12. only --attach: no link lines; help describes the flags", async () => {
    const f = join(tmp(), "note.txt");
    writeFileSync(f, "Заметка.");
    const r = await run([...topic, ...two(), "--max-rounds", "3", "--attach", f]);
    expect(r.code).toBe(EXIT.consensus);
    expect(r.out).toContain("Материалы: 1, объём 8 символов");
    expect(r.out).not.toContain("Источники ссылок");
    for (const s of ["--url", "--preview-materials", "--prepared-materials", "Ссылки:", "не больше 15 секунд, 3 перенаправлений и 2 МиБ"]) expect(help()).toContain(s);
  });
});

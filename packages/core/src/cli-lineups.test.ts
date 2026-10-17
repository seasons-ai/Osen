import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { help, main } from "./cli.ts";
import type { InspectDeps } from "./registry/providers.ts";
import { listSessions, readSession } from "./store/sessions.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-lin-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const sc = (file: string) => join(import.meta.dirname, "../scenarios/consensus", file);
const P1 = sc("p1.json"), P2 = sc("p2.json");
const two = ["--participant", `scripted:${P1}`, "--participant", `scripted:${P2}`];
const FIX = join(import.meta.dirname, "cli-agents/fixtures");
const noCli: Partial<InspectDeps> = { locate: async (agent) => ({ agent, found: false, searchPath: "", reason: `Команда ${agent} не найдена` }) };
const withClaude: Partial<InspectDeps> = {
  locate: (async (a: "claude" | "codex") => a === "claude"
    ? { agent: a, found: true, path: "/stub/claude", version: "1.0.0", searchPath: "" }
    : { agent: a, found: false, searchPath: "", reason: `Команда ${a} не найдена` }) as InspectDeps["locate"],
  readHelp: async () => readFileSync(join(FIX, "claude-2.1.288-help.txt"), "utf8"),
  readFeatures: async () => "",
  listModels: (async () => ({ models: ["opus"], confirmed: true })) as InspectDeps["listModels"],
};

const tpl = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `Название ${id}`, category: "Категория", description: "Описание", exampleTopic: "Пример", framing: `Рамка ${id}`, ...over,
});

interface Opt { home?: string; dev?: boolean; deps?: Partial<InspectDeps>; templates?: Record<string, unknown> }
async function run(argv: string[], o: Opt = {}) {
  const home = o.home ?? tmp();
  const builtinDir = tmp();
  mkdirSync(join(builtinDir, "ru"));
  writeFileSync(join(builtinDir, "ru", "neutral.md"), "Нейтральная рамка теста.");
  for (const [f, d] of Object.entries(o.templates ?? {})) writeFileSync(join(builtinDir, "ru", f), JSON.stringify(d));
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, {
    stdout: (t) => out.push(t), stderr: (t) => err.push(t),
    env: { COUNCIL_HOME: home, ...(o.dev === false ? {} : { COUNCIL_DEV: "1" }) },
    builtinTemplatesDir: builtinDir, inspectDeps: o.deps ?? noCli,
  });
  return { code, home, out: out.join("\n"), err: err.join("\n") };
}
const tpls = { "a.json": tpl("a", { roles: ["Критик", "Автор"] }), "b.json": tpl("b", { roles: ["X", "Y"], framing: "Рамка B", limits: { maxRounds: 4 } }) };
const sessionIds = (home: string) => listSessions(home).map((s) => s.id);
const lineupsFile = (home: string) => join(home, "lineups.json");
const bytes = (f: string) => readFileSync(f);
const writeLineups = (home: string, positions: unknown[], name = "Ручной") => {
  mkdirSync(home, { recursive: true });
  writeFileSync(lineupsFile(home), JSON.stringify([{ id: "x1", name, participants: positions }]));
};

// Session with template a (roles Critic, Author) in a fresh folder
async function seeded() {
  const r = await run(["--topic", "Тема", ...two, "--template", "a", "--max-rounds", "3"], { templates: tpls });
  return { home: r.home, id: sessionIds(r.home)[0]! };
}
const scripted = (file: string, role: string | null) => ({ providerId: "scripted", model: file, role });

describe("council: lineups", () => {
  it("1. save from a session", async () => {
    const { home, id } = await seeded();
    const ev = bytes(join(home, "sessions", id, "events.jsonl"));
    const cfg = bytes(join(home, "config.json"));
    const r = await run(["lineups", "save", "Проверка", "--from-session", id], { home });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Состав \S+ «Проверка» сохранён: участников 2\.\nЗапуск: council --topic "<тема>" --lineup \S+$/);
    const saved = JSON.parse(readFileSync(lineupsFile(home), "utf8"));
    expect(saved).toHaveLength(1);
    expect(saved[0].participants).toEqual([scripted(P1, "Критик"), scripted(P2, "Автор")]);
    expect(bytes(join(home, "sessions", id, "events.jsonl")).equals(ev)).toBe(true);
    expect(sessionIds(home)).toEqual([id]);
    expect(bytes(join(home, "config.json")).equals(cfg)).toBe(true);
  });

  it("2. list and empty list", async () => {
    const { home, id } = await seeded();
    await run(["lineups", "save", "Проверка", "--from-session", id], { home });
    const r = await run(["lineups"], { home });
    expect(r.code).toBe(0);
    expect(r.out).toContain("  Проверка");
    expect(r.out).toContain(`  1. scripted:${P1} — Критик`);
    expect(r.out).toContain(`  2. scripted:${P2} — Автор`);
    const fresh = await run(["lineups"]);
    expect(fresh.out).toBe("Составов нет.");
    expect(existsSync(lineupsFile(fresh.home))).toBe(false);
    expect(existsSync(join(fresh.home, "config.json"))).toBe(false);
  });

  it("3. invalid source", async () => {
    const { home, id } = await seeded();
    const r = await run(["lineups", "save", "A", "--from-session", "nope"], { home });
    expect(r.code).toBe(2);
    expect(r.err).toContain("Сессия nope не найдена или её журнал повреждён.");
    expect(existsSync(lineupsFile(home))).toBe(false);
    writeFileSync(join(home, "sessions", id, "events.jsonl"), "мусор\n{не json");
    const b = await run(["lineups", "save", "A", "--from-session", id], { home });
    expect(b.code).toBe(2);
    expect(existsSync(lineupsFile(home))).toBe(false);
  });

  it("4. duplicate name", async () => {
    const { home, id } = await seeded();
    await run(["lineups", "save", "Проверка", "--from-session", id], { home });
    const before = bytes(lineupsFile(home));
    const r = await run(["lineups", "save", "Проверка", "--from-session", id], { home });
    expect(r.code).toBe(2);
    expect(r.err.length).toBeGreaterThan(0);
    expect(bytes(lineupsFile(home)).equals(before)).toBe(true);
  });

  it("5. launch by lineup: template frame, lineup roles", async () => {
    const { home, id } = await seeded();
    await run(["lineups", "save", "Проверка", "--from-session", id], { home });
    const lid = JSON.parse(readFileSync(lineupsFile(home), "utf8"))[0].id;
    const r = await run(["--topic", "Вторая", "--lineup", lid, "--template", "b", "--max-rounds", "2"], { home, templates: tpls });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Состав: «Проверка» (${lid})`);
    const s = readSession(home, sessionIds(home).find((x) => x !== id)!)!.state.session!;
    expect(s.framing).toBe("Рамка B");
    expect(s.templateId).toBe("b");
    expect(s.origin).toBe("cli");
    expect(s.limits.maxRounds).toBe(2);
    expect(s.participants.map((p) => [p.model, p.role])).toEqual([[P1, "Критик"], [P2, "Автор"]]);
    expect(s.participants.map((p) => p.name)).toEqual(["Участник 1", "Участник 2"]);
  });

  it("5b. null role is not replaced by the template role", async () => {
    const home = tmp();
    writeLineups(home, [scripted(P1, null), scripted(P2, "Автор")]);
    const r = await run(["--topic", "Т", "--lineup", "x1", "--template", "b", "--max-rounds", "2"], { home, templates: tpls });
    expect(r.code).toBe(0);
    const s = readSession(home, sessionIds(home)[0]!)!.state.session!;
    expect(s.participants.map((p) => p.role)).toEqual([null, "Автор"]);
  });

  it("6. --lineup together with --participant", async () => {
    const home = tmp();
    const r = await run(["--topic", "Т", "--lineup", "x1", ...two], { home });
    expect(r.code).toBe(2);
    expect(r.err).toContain("флаги --lineup и --participant несовместимы");
    expect(sessionIds(home)).toEqual([]);
  });

  it("7. unknown lineup", async () => {
    const home = tmp();
    writeLineups(home, [scripted(P1, null), scripted(P2, null)]);
    const r = await run(["--topic", "Т", "--lineup", "nope"], { home });
    expect(r.code).toBe(2);
    expect(r.err).toContain("Состав «nope» не найден. Список: council lineups.");
    expect(sessionIds(home)).toEqual([]);
  });

  it("8. provider removed from the registry", async () => {
    const home = tmp();
    writeLineups(home, [{ providerId: "ghost", model: "m", role: null }, scripted(P2, null)]);
    const before = bytes(lineupsFile(home));
    const r = await run(["--topic", "Т", "--lineup", "x1"], { home });
    expect(r.code).toBe(2);
    expect(r.err).toContain("ghost");
    expect(r.err).toContain("не найден в реестре");
    expect(sessionIds(home)).toEqual([]);
    expect(bytes(lineupsFile(home)).equals(before)).toBe(true);
  });

  it("9. provider unavailable", async () => {
    const home = tmp();
    writeLineups(home, [{ providerId: "claude", model: "default", role: null }, scripted(P2, null)]);
    const r = await run(["--topic", "Т", "--lineup", "x1"], { home });
    expect(r.code).toBe(2);
    expect(r.err).toContain("недоступен");
    expect(r.err).toContain("claude");
    expect(sessionIds(home)).toEqual([]);
  });

  it("10. note about a model not in the list", async () => {
    const home = tmp();
    writeLineups(home, [{ providerId: "claude", model: "haiku-x", role: null }, { providerId: "ghost", model: "m", role: null }]);
    const r = await run(["--topic", "Т", "--lineup", "x1"], { home, deps: withClaude });
    expect(r.code).toBe(2);
    expect(r.err).toContain("haiku-x");
    expect(r.err).toContain("нет в перечне");
    expect(r.err).toContain("ghost");
    expect(sessionIds(home)).toEqual([]);
  });

  it("11. corrupted lineups.json", async () => {
    const home = tmp();
    writeFileSync(lineupsFile(home), "{ не json");
    const before = bytes(lineupsFile(home));
    const l = await run(["lineups"], { home });
    expect(l.code).toBe(2);
    expect(l.err).toContain("lineups.json:");
    expect((await run(["--topic", "Т", "--lineup", "x"], { home })).code).toBe(2);
    const ok = await run(["--topic", "Т", ...two, "--max-rounds", "2"], { home });
    expect(ok.code).toBe(0);
    expect(bytes(lineupsFile(home)).equals(before)).toBe(true);
  });

  it("12. argument errors", async () => {
    const { home, id } = await seeded();
    expect((await run(["resume", id, "--lineup", "x"], { home })).code).toBe(2);
    const fs = await run(["list", "--from-session", id], { home });
    expect(fs.code).toBe(2);
    expect(fs.err).toContain("флаг --from-session принимается только командой lineups save.");
    const ns = await run(["lineups", "save", "A"], { home });
    expect(ns.code).toBe(2);
    expect(ns.err).toContain("Команда lineups save требует --from-session <id>.");
    const ex = await run(["lineups", "лишнее"], { home });
    expect(ex.code).toBe(2);
    expect(ex.err).toContain("Команда lineups: без аргументов");
    expect((await run(["list", "--lineup", "x"], { home })).code).toBe(2);
    expect((await run(["--topic", "Т", "--lineup", ""], { home })).code).toBe(2);
  });

  it("13. scripted positions without COUNCIL_DEV", async () => {
    const home = tmp();
    writeLineups(home, [scripted(P1, null), scripted(P2, null)]);
    const r = await run(["--topic", "Т", "--lineup", "x1"], { home, dev: false });
    expect(r.code).toBe(2);
    expect(r.err).toContain("COUNCIL_DEV");
    expect(readdirSync(home).includes("sessions") ? sessionIds(home) : []).toEqual([]);
  });

  it("14. help", () => {
    expect(help()).toContain("council lineups");
    expect(help()).toContain("--lineup <id>");
    expect(help()).toContain("--from-session <id>");
    expect(help()).toContain("Составы:");
  });
});

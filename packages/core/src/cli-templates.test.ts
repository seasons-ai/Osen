import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { help, main } from "./cli.ts";
import { setProcessLanguage } from "./i18n/process-language.ts";
import { listSessions, readSession } from "./store/sessions.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-tpl-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const sc = (file: string) => join(import.meta.dirname, "../scenarios/consensus", file);
const two = ["--participant", `scripted:${sc("p1.json")}`, "--participant", `scripted:${sc("p2.json")}`];
const NEUTRAL = "Нейтральная рамка теста.";

const tpl = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `Название ${id}`, category: "Категория", description: "Описание", exampleTopic: "Пример", framing: `Рамка ${id}`, ...over,
});
const put = (dir: string, file: string, data: unknown) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), typeof data === "string" ? data : JSON.stringify(data));
};

interface Setup { lang?: "ru" | "en"; builtin?: Record<string, unknown>; user?: Record<string, unknown>; userNeutral?: string }

async function run(argv: string[], setup: Setup = {}) {
  const home = tmp();
  const builtinDir = tmp();
  const langDir = join(builtinDir, setup.lang ?? "ru");
  put(langDir, "neutral.md", NEUTRAL);
  for (const [f, d] of Object.entries(setup.builtin ?? {})) put(langDir, f, d);
  for (const [f, d] of Object.entries(setup.user ?? {})) put(join(home, "templates"), f, d);
  if (setup.userNeutral !== undefined) put(join(home, "templates"), "neutral.md", setup.userNeutral);
  const out: string[] = [], err: string[] = [];
  setProcessLanguage(setup.lang ?? "ru"); // the process language is set by the entry point; in the test, explicitly
  const code = await main(argv, {
    stdout: (t) => out.push(t), stderr: (t) => err.push(t),
    env: { COUNCIL_HOME: home, COUNCIL_DEV: "1", COUNCIL_LANG: setup.lang ?? "ru" }, builtinTemplatesDir: builtinDir,
    inspectDeps: { locate: async (agent) => ({ agent, found: false, searchPath: "", reason: `Команда ${agent} не найдена` }) },
  });
  setProcessLanguage("ru");
  return { code, home, builtinDir, out: out.join("\n"), outLines: out, err: err.join("\n") };
}

const session = (home: string) => {
  const [s] = listSessions(home);
  return readSession(home, s!.id)!.state.session!;
};
const start = ["--topic", "Как назвать кота", ...two];

describe("council: templates", () => {
  it("1. templates: two built-in ones in two categories", async () => {
    const r = await run(["templates"], { builtin: { "a.json": tpl("a", { category: "Первая" }), "b.json": tpl("b", { category: "Вторая" }) } });
    expect(r.code).toBe(0);
    expect(r.outLines).toContain("a  Первая  Название a  встроенный");
    expect(r.outLines).toContain("b  Вторая  Название b  встроенный");
    expect(r.out).not.toContain("Ошибки загрузки:");
  });

  it("1b. templates in en: set from the en folder, Russian set not visible", async () => {
    const r = await run(["templates"], { lang: "en", builtin: { "e.json": tpl("e", { category: "First" }) } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("e  First  Название e");
    expect(r.out).toMatch(/built-in/);
    expect(r.out).not.toContain("Ошибки загрузки");
  });

  it("1c. launch with a template in en takes the en set frame; user template and neutral.md override on both languages", async () => {
    for (const lang of ["ru", "en"] as const) {
      const r = await run(["--template", "a", ...start], { lang, builtin: { "a.json": tpl("a") }, user: { "a.json": tpl("a", { framing: "Рамка владельца" }) }, userNeutral: "Нейтраль владельца" });
      expect(r.code).toBe(0);
      expect(session(r.home).framing).toBe("Рамка владельца");
      const n = await run(start, { lang, userNeutral: "Нейтраль владельца" });
      expect(session(n.home).framing).toBe("Нейтраль владельца");
      const b = await run(["--template", "a", ...start], { lang, builtin: { "a.json": tpl("a") } });
      expect(session(b.home).framing).toBe("Рамка a");
    }
  });

  it("2. templates: user template with a new id", async () => {
    const r = await run(["templates"], { user: { "u.json": tpl("u") } });
    expect(r.outLines).toContain("u  Категория  Название u  пользовательский");
  });

  it("3. templates: user template overrides the built-in one", async () => {
    const r = await run(["templates"], { builtin: { "a.json": tpl("a") }, user: { "a.json": tpl("a", { title: "Новое" }) } });
    const lines = r.outLines.filter((l) => l.startsWith("a  "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Новое");
    expect(lines[0]).toContain("пользовательский");
    expect(JSON.parse(readFileSync(join(r.builtinDir, "ru", "a.json"), "utf8")).title).toBe("Название a");
  });

  it("4. templates: load errors next to valid ones", async () => {
    const { framing: _f, ...noFraming } = tpl("c");
    const r = await run(["templates"], { builtin: { "a.json": tpl("a"), "broken.json": "{ не json", "nofr.json": noFraming } });
    expect(r.code).toBe(0);
    expect(r.outLines.some((l) => l.startsWith("a  "))).toBe(true);
    expect(r.outLines).toContain("Ошибки загрузки:");
    expect(r.outLines.some((l) => l.includes("broken.json"))).toBe(true);
    expect(r.outLines.some((l) => l.includes("nofr.json") && l.includes("framing"))).toBe(true);
  });

  it("5. templates: empty", async () => {
    const r = await run(["templates"]);
    expect(r.outLines).toContain("Шаблонов нет.");
  });

  it("6. templates with an argument", async () => {
    const r = await run(["templates", "лишнее"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Команда templates не принимает аргументов.");
  });

  const three = { "t.json": tpl("t", { roles: ["Роль 1", "Роль 2", "Роль 3"], limits: { maxRounds: 4 } }) };

  it("7. launch with a template", async () => {
    const r = await run([...start, "--template", "t"], { builtin: three });
    expect(r.code).toBe(0);
    const s = session(r.home);
    expect(s.templateId).toBe("t");
    expect(s.framing).toBe("Рамка t");
    expect(s.participants.map((p) => p.role)).toEqual(["Роль 1", "Роль 2"]);
    expect(s.limits.maxRounds).toBe(4);
    expect(r.outLines).toContain("Шаблон: t");
  });

  it("8. limit from the flag overrides the template", async () => {
    const r = await run([...start, "--template", "t", "--max-rounds", "2"], { builtin: three });
    expect(session(r.home).limits.maxRounds).toBe(2);
  });

  it("9. launch without a template", async () => {
    const r = await run(start);
    const s = session(r.home);
    expect(s.templateId).toBeNull();
    expect(s.framing).toBe(NEUTRAL);
    expect(s.participants.map((p) => p.role)).toEqual([null, null]);
    expect(s.limits.maxRounds).toBe(5);
    expect(r.out).not.toContain("Шаблон:");
  });

  it("10. user neutral frame", async () => {
    const r = await run(start, { userNeutral: "Своя нейтральная" });
    expect(session(r.home).framing).toBe("Своя нейтральная");
  });

  it("11. --framing overrides the template frame", async () => {
    const r = await run([...start, "--template", "t", "--framing", "Своя рамка"], { builtin: three });
    const s = session(r.home);
    expect(s.framing).toBe("Своя рамка");
    expect(s.templateId).toBe("t");
  });

  it("12. unknown template", async () => {
    const r = await run([...start, "--template", "nope"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("nope");
    expect(listSessions(r.home)).toEqual([]);
  });

  it("13. changing the template does not change the previous session", async () => {
    const r = await run([...start, "--template", "u"], { user: { "u.json": tpl("u", { framing: "Старая рамка" }) } });
    const id = listSessions(r.home)[0]!.id;
    put(join(r.home, "templates"), "u.json", tpl("u", { framing: "Новая рамка" }));
    expect(readSession(r.home, id)!.state.session!.framing).toBe("Старая рамка");
  });

  it("14. help", () => {
    expect(help()).toContain("--template");
    expect(help()).toContain("council templates");
  });
});

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { help, main } from "./cli.ts";
import { readEvents } from "./store/journal.ts";
import { listSessions } from "./store/sessions.ts";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-drf-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

type Step = Record<string, unknown>;
const resp = (stance: string, solution: string | null, extra: Record<string, unknown> = {}): Step => ({
  response: { stance, reasoning: `обоснование ${solution ?? stance}`, solution, answers: [], questions: [], ...extra },
});
const amend = (t: string) => resp("amend", t);
const agree = () => resp("agree", null);
const dir = tmp();
let n = 0;
const scen = (...steps: Step[]) => { const f = join(dir, `s${++n}.json`); writeFileSync(f, JSON.stringify({ steps })); return f; };
const parts = (...files: string[]) => files.flatMap((f) => ["--participant", `scripted:${f}`]);
const two = () => parts(scen(amend("ЧЕРНОВИК-А"), agree(), agree()), scen(amend("ЧЕРНОВИК-Б"), amend("ВЕРСИЯ-Б"), agree()));

async function run(argv: string[], home = tmp()) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, { stdout: (t) => out.push(t), stderr: (t) => err.push(t), env: { COUNCIL_HOME: home, COUNCIL_DEV: "1" } });
  return { code, home, out: out.join("\n"), err: err.join("\n") };
}
const base = ["--topic", "Тема"];
const sessionIds = (home: string) => listSessions(home).map((s) => s.id);
const idx = (s: string, sub: string) => s.indexOf(sub);

describe("council: independent drafts", () => {
  it("1. launch: experiment line, drafts before the first turn, synthesizer goes first", async () => {
    const r = await run([...base, ...two(), "--max-rounds", "2", "--drafts", "--synthesizer", "p2"]);
    expect(r.code).toBe(0);
    const line = /Эксперимент «независимые черновики»: синтезатор p2 «[^»]+», не более 18 вызовов моделей \(участников 2 × \(кругов 2 \+ 1\) × 3\)\./.exec(r.out);
    expect(line).not.toBeNull();
    expect(idx(r.out, line![0])).toBeLessThan(idx(r.out, "── Черновик"));
    const d1 = idx(r.out, "── Черновик p1"), d2 = idx(r.out, "── Черновик p2"), t1 = idx(r.out, "── Ход");
    expect(d1).toBeGreaterThan(-1);
    expect(d2).toBeGreaterThan(d1);
    expect(t1).toBeGreaterThan(d2);
    expect(r.out).toMatch(/── Ход 1 · круг 1 · p2 «[^»]+» · amend → версия 1/);
    expect(r.out).toContain("Черновики готовы: 2 из 2");
    expect(r.out).toMatch(/Текст:\nЧЕРНОВИК-А/);
    expect(r.out).toMatch(/Текст:\nЧЕРНОВИК-Б/);
    expect(r.out).not.toContain("(текст черновика недоступен)");
  });

  it("2. without --synthesizer: first participant by default", async () => {
    const r = await run([...base, ...two(), "--max-rounds", "2", "--drafts"]);
    expect(r.out).toMatch(/синтезатор p1 «[^»]+» \(по умолчанию — первый участник\), не более 18/);
  });

  it("3. unknown synthesizer: exit code 2, no session, participants not called", async () => {
    const r = await run([...base, ...two(), "--drafts", "--synthesizer", "p9"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("p9");
    expect(sessionIds(r.home)).toEqual([]);
    expect(r.out).toBe("");
  });

  it("4. --synthesizer without --drafts: exit code 2, no session", async () => {
    const r = await run([...base, ...two(), "--synthesizer", "p2"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--synthesizer работает только вместе с --drafts.");
    expect(sessionIds(r.home)).toEqual([]);
  });

  it("5. without --drafts the output does not mention drafts", async () => {
    const r = await run([...base, ...two(), "--max-rounds", "2"]);
    expect(r.out).not.toMatch(/Эксперимент|Черновик|черновик/);
  });

  it.each([["resume", "x"], ["say", "x", "текст"], ["show", "x"]])("6. --drafts с командой %s: код 2", async (...argv) => {
    const r = await run([...argv, "--drafts"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--drafts");
  });

  it("7. draft with an error: owner question rejected, retry accepted", async () => {
    const bad = resp("amend", "первая", { questions: [{ to: "owner", text: "Что делать?" }] });
    const r = await run([...base, ...parts(scen(bad, amend("ЧЕРНОВИК-А"), agree()), scen(amend("ЧЕРНОВИК-Б"), amend("В"), agree())), "--max-rounds", "2", "--drafts"]);
    expect(r.out).toMatch(/✗ Черновик p1 «[^»]+» · попытка 1 · invalid_response/);
    expect(idx(r.out, "✗ Черновик p1")).toBeLessThan(idx(r.out, "── Черновик p1"));
    expect(r.out).toMatch(/── Черновик p1 «[^»]+» · попыток 2/);
    expect(r.out).not.toContain("Вопрос владельцу");
  });

  it("8. synthesizer dropped out in the phase: failure, p3 does not write a draft", async () => {
    const dead = scen({ error: "упал", retryable: false });
    const r = await run([...base, ...parts(scen(amend("A"), agree()), dead, scen(amend("C"), agree())), "--drafts", "--synthesizer", "p2"]);
    expect(r.code).toBe(5);
    expect(r.out).toMatch(/Причина: синтезатор p2 «[^»]+» выбыл, не создав версию 1; замены нет — запустите новую сессию с другим синтезатором \(--synthesizer\)\./);
    expect(r.out).not.toContain("── Черновик p3");
    expect(r.out).not.toContain("── Ход");
  });

  it("9. context limit: failure before the discussion", async () => {
    const r = await run([...base, ...two(), "--drafts", "--context-chars", "5"]);
    expect(r.code).toBe(5);
    expect(r.out).toMatch(/Причина: черновики не помещаются в лимит контекста \(\d+ знаков из 5 допустимых по --context-chars\); общее обсуждение не начато\./);
    expect(r.out).not.toContain("── Ход");
  });

  it("10. show: drafts with texts; does not crash without a snapshot", async () => {
    const r = await run([...base, ...two(), "--max-rounds", "2", "--drafts"]);
    const id = sessionIds(r.home)[0]!;
    const s = await run(["show", id], r.home);
    expect(s.code).toBe(0);
    expect(s.out).toMatch(/Текст:\nЧЕРНОВИК-А/);
    expect(s.out).toMatch(/Всего: ходов \d+, черновиков 2/);
    rmSync(join(r.home, "sessions", id, "drafts", "d1.txt"));
    const t = await run(["show", id], r.home);
    expect(t.code).toBe(0);
    expect(t.out).toContain("(текст черновика недоступен)");
    expect(t.out).toMatch(/Текст:\nЧЕРНОВИК-Б/);
  });

  // Session with three participants; the journal is cut right after p2's draft starts; snapshots d2, d3 deleted
  async function interrupted() {
    const files = [
      scen(amend("ЧЕРНОВИК-1"), agree(), agree()),
      scen(amend("ЧЕРНОВИК-2"), amend("ЧЕРНОВИК-2"), amend("ВЕРСИЯ"), agree(), agree()),
      scen(amend("ЧЕРНОВИК-3"), agree(), agree()),
    ];
    const r = await run([...base, ...parts(...files), "--max-rounds", "2", "--drafts", "--synthesizer", "p2"]);
    const id = sessionIds(r.home)[0]!;
    const ev = join(r.home, "sessions", id, "events.jsonl");
    const evs = readEvents(r.home, id)!.events;
    const k = evs.findIndex((e) => e.type === "draft_attempt_started" && e.participantId === "p2");
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise((res) => child.once("exit", res));
    const cut = evs.slice(0, k + 1).map((e) => (e.type === "session_created" ? { ...e, pid: child.pid } : e));
    writeFileSync(ev, cut.map((e) => JSON.stringify(e)).join("\n") + "\n");
    for (const d of ["d2", "d3"]) rmSync(join(r.home, "sessions", id, "drafts", `${d}.txt`), { force: true });
    return { home: r.home, id, ev };
  }

  it("11. resume in the phase: boundary with remaining draft calls, p1 does not write again", async () => {
    const { home, id } = await interrupted();
    const r = await run(["resume", id], home);
    expect(r.out).toMatch(/Продолжение сессии \S+: ещё кругов 2 \(общий лимит 2\), не более 23 вызовов моделей \(активных участников 3 × 2 × 3 \+ остаток вызовов черновиков 5\)\./);
    expect(r.out).not.toContain("── Черновик p1");
    expect(r.out).toContain("── Черновик p2");
    expect(r.out).toContain("── Черновик p3");
    expect(r.out).toContain("Черновики готовы: 3 из 3");
  });

  it("12. resume with a corrupted snapshot: exit code 2, journal unchanged", async () => {
    const { home, id, ev } = await interrupted();
    writeFileSync(join(home, "sessions", id, "drafts", "d1.txt"), "испорчено");
    const before = readFileSync(ev);
    const r = await run(["resume", id], home);
    expect(r.code).toBe(2);
    expect(r.err).toContain("d1");
    expect(readFileSync(ev).equals(before)).toBe(true);
  });

  it("13. help", () => {
    expect(help()).toContain("--drafts");
    expect(help()).toContain("--synthesizer");
  });
});

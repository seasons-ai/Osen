import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_WAIT_DEFAULT_SEC, appendEvent, createSessionJournal, materialFromText, materialPath, sessionDir, verifyMaterials, writeMaterialSnapshots, writeMaterialSources, readMaterialSources, safeSource } from "@model-council/core";
import { loadTemplates } from "@model-council/core";
import type { Session, SessionEvent, TemplateCatalog, UrlResponse, UrlTransport } from "@model-council/core";
import { createMaterialsDraft } from "./materials.ts";
import { RerunError, prepareRerun } from "./rerun.ts";

const created = new Date(2026, 2, 5, 23, 30, 0);
const ts = created.toISOString();
const MARK = "МЕТКА-ТЕКСТА-МАТЕРИАЛА";
const FRAMING = "Рамка шаблона: обсуждаем строго по делу.";
const NEUTRAL = "Нейтральная рамка.";
const LIMIT = 100_000;

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "council-rerun-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const catalog = (o: { framing?: string; neutral?: string; none?: boolean } = {}): TemplateCatalog =>
  ({ templates: o.none ? [] : [{ id: "tpl", framing: o.framing ?? FRAMING }], errors: [], neutralFraming: o.neutral ?? NEUTRAL }) as unknown as TemplateCatalog;

const deadPid = (() => { const r = spawnSync(process.execPath, ["-e", ""]); return r.pid; })();

interface Opts {
  texts?: string[] | null; decision?: string | null; finish?: boolean; pid?: number; templateId?: string | null; framing?: string; maxRounds?: number; id?: string; ownerWait?: Session["ownerWait"];
}
function make(o: Opts = {}) {
  const id = o.id ?? "s1";
  const mats = o.texts === null ? undefined : (o.texts ?? [`${MARK} раз`, "два"]).map((t, i) => materialFromText(`m${i + 1}`, `f${i + 1}.txt`, t));
  const session: Session = {
    id, createdAt: ts, origin: "desktop", topic: "Тема сессии", templateId: o.templateId === undefined ? "tpl" : o.templateId, framing: o.framing ?? FRAMING,
    participants: [
      { id: "p1", name: "n1", providerId: "scripted", model: "m1", role: "критик" },
      { id: "p2", name: "n2", providerId: "scripted", model: "m2", role: null },
    ],
    limits: { maxRounds: o.maxRounds ?? 4, turnTimeoutSec: 60, contextChars: 1000 },
    ...(o.ownerWait ? { ownerWait: o.ownerWait } : {}),
    ...(mats ? { materials: mats.map(({ id, name, chars, sha256 }) => ({ id, name, chars, sha256 })) } : {}),
  };
  createSessionJournal(dir, id);
  const events: SessionEvent[] = [{ seq: 1, ts, type: "session_created", session, pid: o.pid ?? deadPid! }];
  const decision = o.decision === undefined ? "Итоговое решение" : o.decision;
  if (decision !== null) {
    events.push(
      { seq: 2, ts, type: "turn_started", turn: 1, round: 1, participantId: "p1" },
      { seq: 3, ts, type: "turn_completed", turn: 1, round: 1, participantId: "p1", stance: "amend", normalized: false, reasoning: "ok", solution: decision, version: 1, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1 },
    );
  }
  if (o.finish !== false) events.push({ seq: events.length + 1, ts, type: "session_finished", status: "consensus", version: decision === null ? null : 1, agreed: [], objectors: [] });
  for (const e of events) appendEvent(dir, id, e);
  if (mats) writeMaterialSnapshots(dir, id, mats);
  return { id, mats: mats ?? [] };
}

const draft = () => createMaterialsDraft({ limits: () => ({ materialsChars: LIMIT, materialsIgnore: [] }) });
const run = (id: string, withDecision = false, o: Parameters<typeof catalog>[0] = {}, d = draft()) => ({ d, v: prepareRerun({ dataDir: dir, catalog: () => catalog(o), materials: d }, id, withDecision) });

type Step = { v: number } | { sel: number } | { fin: number | null };
// Journal from steps: version n (text "T<n>"), owner choice, a finish event. Without materials.
function journal(id: string, steps: Step[]) {
  const session: Session = {
    id, createdAt: ts, origin: "desktop", topic: "Тема", templateId: null, framing: NEUTRAL,
    participants: [{ id: "p1", name: "n1", providerId: "scripted", model: "m1", role: null }, { id: "p2", name: "n2", providerId: "scripted", model: "m2", role: null }],
    limits: { maxRounds: 4, turnTimeoutSec: 60, contextChars: 1000 },
  };
  createSessionJournal(dir, id);
  const body: Omit<SessionEvent, "seq" | "ts">[] = [{ type: "session_created", session, pid: deadPid! } as never];
  let turn = 0;
  for (const s of steps) {
    if ("v" in s) {
      turn++;
      body.push({ type: "turn_started", turn, round: 1, participantId: "p1" } as never,
        { type: "turn_completed", turn, round: 1, participantId: "p1", stance: "amend", normalized: false, reasoning: "ok", solution: `T${s.v}`, version: s.v, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1 } as never);
    } else if ("sel" in s) body.push({ type: "owner_selected_version", version: s.sel, statusAtSelection: "no_consensus" } as never);
    else body.push({ type: "session_finished", status: "no_consensus", version: s.fin, agreed: [], objectors: [] } as never);
  }
  body.forEach((e, i) => appendEvent(dir, id, { ...e, seq: i + 1, ts } as SessionEvent));
}

function fingerprint(id: string): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { files.push(`${p}/`); walk(p); } else files.push(`${p} ${statSync(p).mtimeMs} ${readFileSync(p).toString("base64")}`);
    }
  };
  walk(sessionDir(dir, id));
  return files.join("\n");
}

describe("prepareRerun", () => {
  it.each([
    ["оба режима", { pauseAfterRound: true, waitForOwner: true, timeoutSec: 60 }, { pauseAfterRound: true, waitForOwner: true, timeoutSec: 60 }],
    ["пауза без срока", { pauseAfterRound: true }, { pauseAfterRound: true, waitForOwner: false, timeoutSec: OWNER_WAIT_DEFAULT_SEC }],
    ["ответ без паузы", { waitForOwner: true, timeoutSec: 60 }, { pauseAfterRound: false, waitForOwner: true, timeoutSec: 60 }],
    ["нет поля", undefined, null],
    ["оба режима выключены", { pauseAfterRound: false, waitForOwner: false, timeoutSec: 60 }, null],
    ["нет режимов", { timeoutSec: 60 }, null],
  ])("ожидание владельца: %s", (_n, ownerWait, want) => {
    const { id } = make({ ownerWait });
    expect(run(id).v.ownerWait).toEqual(want);
  });

  it("whole snapshots without a decision: topic, participants, rounds, date, materials", () => {
    const { id } = make();
    const { v, d } = run(id);
    expect(v).toMatchObject({ sessionId: id, date: "2026-03-05", topic: "Тема сессии", templateId: "tpl", maxRounds: 4 });
    expect(v.participants).toEqual([{ providerId: "scripted", model: "m1", role: "критик" }, { providerId: "scripted", model: "m2", role: null }]);
    expect(v.materials.items.map((i) => [i.id, i.name])).toEqual([["m1", "f1.txt"], ["m2", "f2.txt"]]);
    expect(v.materials.error).toBeNull();
    expect(verifyMaterials(d.take(), LIMIT)).toEqual([]);
  });

  it("withDecision: the decision last, chars equals the length, text in take", () => {
    const { id } = make({ decision: "Итоговое решение" });
    const { v, d } = run(id, true);
    const last = v.materials.items.at(-1)!;
    expect(last).toEqual({ id: "m3", name: "Решение прошлой сессии: версия 1, 2026-03-05", chars: "Итоговое решение".length, source: null });
    expect(d.take().at(-1)!.text).toBe("Итоговое решение");
  });

  it("a corrupted and a deleted snapshot are not carried, the rest are renumbered", () => {
    const { id } = make({ texts: ["один", "два", "три"] });
    writeFileSync(materialPath(dir, id, "m1"), "ИЗМЕНЕНО", "utf8");
    rmSync(materialPath(dir, id, "m2"));
    const { v } = run(id);
    expect(v.materials.items).toEqual([{ id: "m1", name: "f3.txt", chars: 3, source: null }]);
    expect(v.materials.error).toBe("Материал «f1.txt» не перенесён: хеш не совпал\nМатериал «f2.txt» не перенесён: нет снимка");
  });

  it("frame and template", () => {
    const a = make({ id: "a", framing: FRAMING });
    expect(run(a.id).v).toMatchObject({ templateId: "tpl", framingFromSession: false });
    expect(run(a.id, false, { framing: "Новая рамка шаблона" }).v).toMatchObject({ templateId: "tpl", framingFromSession: true });
    expect(run(a.id, false, { none: true }).v).toMatchObject({ templateId: null, framingFromSession: true });
    const n = make({ id: "n", templateId: null, framing: NEUTRAL });
    expect(run(n.id, false, { none: true }).v).toMatchObject({ templateId: null, framingFromSession: false });
    expect(run(n.id, false, { none: true, neutral: "Другая нейтральная" }).v.framingFromSession).toBe(true);
  });

  it("after a language change the catalog is different, the frame is the recorded one, framingFromSession is true", () => {
    const root = join(dir, "builtin");
    for (const [lang, framing] of [["ru", FRAMING], ["en", "Framing: discuss strictly on point."]] as const) {
      mkdirSync(join(root, lang), { recursive: true });
      writeFileSync(join(root, lang, "neutral.md"), NEUTRAL);
      writeFileSync(join(root, lang, "tpl.json"), JSON.stringify({ id: "tpl", title: "T", category: "K", description: "d", exampleTopic: "t", framing }));
    }
    const a = make({ id: "a", framing: FRAMING });
    const prepare = () => prepareRerun({ dataDir: dir, catalog: () => loadTemplates({ builtinDir: root, userDir: join(dir, "user") }), materials: draft() }, a.id, false);
    expect(prepare()).toMatchObject({ templateId: "tpl", framingFromSession: false });
    setProcessLanguage("en");
    try {
      expect(prepare()).toMatchObject({ templateId: "tpl", framingFromSession: true });
    } finally {
      setProcessLanguage("ru");
    }
  });

  it("session without versions: withDecision refusal and the draft unchanged, without withDecision the view is built", () => {
    const { id } = make({ decision: null });
    const d = draft();
    const before = d.carry([materialFromText("m1", "старое.txt", "старое")], []);
    expect(() => run(id, true, {}, d)).toThrow(new RerunError("У сессии нет ни одной версии решения: обсуждать дальше нечего."));
    expect(d.view()).toEqual(before);
    expect(run(id, false, {}, d).v.materials.items).toHaveLength(2);
  });

  it("no session and a running one — refusal; an interrupted one — the view is built", () => {
    expect(() => run("zz")).toThrow(new RerunError("Сессия zz не найдена."));
    const live = make({ id: "live", finish: false, pid: 1, decision: null });
    expect(() => run(live.id)).toThrow(new RerunError("Сессия ещё идёт: повтор доступен после завершения."));
    const dead = make({ id: "dead", finish: false, decision: null });
    expect(run(dead.id).v.topic).toBe("Тема сессии");
  });

  it("session without a materials field: an empty list", () => {
    const { id } = make({ texts: null });
    const { v } = run(id);
    expect(v.materials).toMatchObject({ items: [], error: null });
    expect(v.topic).toBe("Тема сессии");
  });

  it("maxRounds is clamped to the bounds", () => {
    expect(run(make({ id: "hi", maxRounds: 99 }).id).v.maxRounds).toBe(20);
  });

  it("the previous session does not change", () => {
    const { id } = make();
    const before = fingerprint(id);
    run(id, true);
    expect(fingerprint(id)).toBe(before);
  });

  it("the view has no data folder path, texts, frame or sha256", () => {
    const { id } = make();
    const json = JSON.stringify(run(id, true).v);
    for (const bad of [dir, MARK, FRAMING, "sha256", "Итоговое решение"]) expect(json).not.toContain(bad);
  });

  it("a repeated call replaces the draft without duplicates", () => {
    const { id } = make();
    const d = draft();
    run(id, true, {}, d);
    const { v } = run(id, true, {}, d);
    expect(v.materials.items.map((i) => i.name)).toEqual(["f1.txt", "f2.txt", "Решение прошлой сессии: версия 1, 2026-03-05"]);
    expect(d.take()).toHaveLength(3);
  });
});

describe("rerun: language", () => {
  afterEach(() => setProcessLanguage("ru"));
  const cyr = /[А-Яа-яЁё]/;
  const msg = (f: () => unknown) => { try { f(); } catch (e) { expect(e).toBeInstanceOf(RerunError); return (e as Error).message; } return "no error"; };

  it("refusals: no session, running, no decision — en, then ru on the same data", () => {
    const live = make({ id: "live", finish: false, pid: 1, decision: null });
    const none = make({ id: "none", decision: null });
    const cases: [() => unknown, string, string][] = [
      [() => run("zz"), "Session zz not found.", "Сессия zz не найдена."],
      [() => run(live.id), "The session is still running: a rerun is available once it finishes.", "Сессия ещё идёт: повтор доступен после завершения."],
      [() => run(none.id, true), "The session has no solution version: there is nothing to discuss further.", "У сессии нет ни одной версии решения: обсуждать дальше нечего."],
    ];
    for (const [f, en, ru] of cases) {
      setProcessLanguage("en");
      const m = msg(f);
      expect(m).toBe(en);
      expect(m).not.toMatch(cyr);
      setProcessLanguage("ru");
      expect(msg(f)).toBe(ru);
    }
  });

  it("a material not carried: the core reason verbatim, the wrapper in the rerun language", () => {
    const { id } = make({ texts: ["один", "два"] });
    writeFileSync(materialPath(dir, id, "m1"), "ИЗМЕНЕНО", "utf8");
    setProcessLanguage("en");
    const en = run(id).v.materials.error!;
    setProcessLanguage("ru");
    const ru = run(id).v.materials.error!;
    expect(ru).toBe("Материал «f1.txt» не перенесён: хеш не совпал");
    expect(en).toMatch(/^Material “f1\.txt” was not carried over: .+/);
    const reason = (s: string) => s.slice(s.indexOf(": ") + 2);
    expect(reason(en)).not.toBe("");
    expect(reason(ru)).toBe("хеш не совпал");
  });

  it("decision material name: at en English with the same date; after a language change the draft has the same name", () => {
    const { id } = make();
    setProcessLanguage("ru");
    const ruName = run(id, true).v.materials.items.at(-1)!.name;
    expect(ruName).toBe("Решение прошлой сессии: версия 1, 2026-03-05");
    setProcessLanguage("en");
    const { d, v } = run(id, true);
    expect(v.materials.items.at(-1)!.name).toBe("Solution of the previous session: version 1, 2026-03-05");
    setProcessLanguage("ru");
    expect(d.view().items.at(-1)!.name).toBe("Solution of the previous session: version 1, 2026-03-05");
    expect(d.take().at(-1)!.name).toBe("Solution of the previous session: version 1, 2026-03-05");
  });

  it("the previous session does not change on a refusal in another language", () => {
    const { id } = make({ decision: null });
    const before = fingerprint(id);
    setProcessLanguage("en");
    msg(() => run(id, true));
    expect(fingerprint(id)).toBe(before);
  });
});

describe("prepareRerun: owner choice and result", () => {
  afterEach(() => setProcessLanguage("ru"));
  const carried = (id: string) => { const { v, d } = run(id, true); return { name: v.materials.items.at(-1)!.name, text: d.take().at(-1)!.text, names: v.materials.items.map((i) => i.name) }; };

  it("owner choice: the chosen version is carried", () => {
    journal("a", [{ v: 1 }, { v: 2 }, { v: 3 }, { sel: 1 }, { fin: 3 }]);
    const c = carried("a");
    expect(c.text).toBe("T1");
    expect(c.name).toBe("Выбор владельца: версия 1 прошлой сессии 2026-03-05");
    expect(c.names.some((n) => n.startsWith("Решение прошлой сессии"))).toBe(false);
  });

  it("choice before a resume: the choice version is carried, not a later one", () => {
    journal("b", [{ v: 1 }, { v: 2 }, { fin: 2 }, { sel: 1 }, { v: 3 }, { v: 4 }, { fin: 4 }]);
    expect(carried("b")).toMatchObject({ text: "T1", name: "Выбор владельца: версия 1 прошлой сессии 2026-03-05" });
  });

  it("without a choice: the final version from the finish, not the last one", () => {
    journal("c", [{ v: 1 }, { v: 2 }, { fin: 2 }, { v: 3 }]);
    expect(carried("c")).toMatchObject({ text: "T2", name: "Решение прошлой сессии: версия 2, 2026-03-05" });
  });

  it("the chosen version is not in the journal — the final one is carried, without a refusal", () => {
    journal("d", [{ v: 1 }, { v: 2 }, { sel: 9 }, { fin: 2 }]);
    expect(carried("d")).toMatchObject({ text: "T2", name: "Решение прошлой сессии: версия 2, 2026-03-05" });
  });

  it("both languages: choice and decision names", () => {
    journal("e", [{ v: 1 }, { v: 2 }, { sel: 1 }, { fin: 2 }]);
    journal("f", [{ v: 1 }, { v: 2 }, { fin: 2 }]);
    setProcessLanguage("en");
    expect(carried("e").name).toBe("Owner's choice: version 1 of the previous session 2026-03-05");
    expect(carried("f").name).toBe("Solution of the previous session: version 2, 2026-03-05");
  });
});

describe("prepareRerun: links", () => {
  const withLink = () => {
    const { id } = make({ texts: ["один", "текст ссылки", "три"] });
    writeMaterialSources(dir, id, [safeSource(new URL("https://example.org/doc?token=SECRET"), "m2", new Date("2026-03-05T10:00:00Z"))]);
    return id;
  };
  const failing = (): UrlTransport & { n: number } => ({ n: 0, async resolve() { this.n++; return []; }, async request() { this.n++; throw new Error("сеть не нужна"); } });

  it("rerun of a session with a link: the source is carried, the transport not called, the start writes sources.json with a new number", () => {
    const id = withLink();
    // a deleted first material shifts the number: the carry goes by snapshots, so we check the number after deletion
    const transport = failing();
    const d = createMaterialsDraft({ limits: () => ({ materialsChars: LIMIT, materialsIgnore: [] }), transport });
    const { v } = run(id, false, {}, d);
    expect(v.materials.items.map((i) => [i.id, i.source?.label ?? null])).toEqual([["m1", null], ["m2", "example.org/doc"], ["m3", null]]);
    d.remove("m1");
    const snap = d.snapshot();
    expect(snap.sources).toMatchObject([{ id: "m1", host: "example.org", pathname: "/doc" }]);
    expect(snap.materials[0]!.id).toBe("m1");
    expect(JSON.stringify(snap.sources)).not.toContain("SECRET");
    expect(transport.n).toBe(0);
    expect(readMaterialSources(dir, id)).toHaveLength(1); // the previous session is untouched
  });

  it("sources.json corrupted: the material is carried without a mark, the rest are carried", () => {
    const id = withLink();
    writeFileSync(join(sessionDir(dir, id), "materials", "sources.json"), "{не json");
    const { v } = run(id);
    expect(v.materials.items.map((i) => [i.id, i.source])).toEqual([["m1", null], ["m2", null], ["m3", null]]);
  });
});

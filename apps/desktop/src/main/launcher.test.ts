import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_TEMPLATES_DIR, readMaterialSources, OWNER_WAIT_MAX_SEC, createScriptedDriver, createSession, readEvents, initialRegistry, savePreparedMaterials, listSessions, loadTemplates, readSession, runStoredSession } from "@model-council/core";
import type { Logger, Session, UrlResponse, UrlTransport } from "@model-council/core";
import { createLauncher, LaunchError } from "./launcher.ts";
import { createMaterialsDraft } from "./materials.ts";
import { previewMaterials } from "./materials-preview.ts";
import { PREVIEW_RETRY_CODE, rosterNames, scriptedProviderLabel } from "../shared/setup.ts";
import { getProcessLanguage, setProcessLanguage } from "@model-council/core/i18n";

const SCEN = join(import.meta.dirname, "../../../../packages/core/scenarios/consensus");
const logs: string[] = [];
const logger: Logger = { info: (m) => { logs.push(m); }, error: () => {} };
const scripted = (role: string | null = null, model = "p1") => ({ providerId: "scripted", model, role });
const ok = { templateId: "pricing", topic: "Тема", participants: [scripted("  Скептик ", "p1"), scripted("", "p2")], maxRounds: 3 };

let dir: string;
let runs: Promise<unknown>[];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "council-launch-")); runs = []; logs.length = 0; });
afterEach(async () => { await Promise.allSettled(runs); rmSync(dir, { recursive: true, force: true }); });

const catalog = () => loadTemplates({ builtinDir: BUILTIN_TEMPLATES_DIR, userDir: join(dir, "templates") });
function make(extra: Partial<Parameters<typeof createLauncher>[0]> = {}) {
  return createLauncher({
    dataDir: dir, env: { COUNCIL_DEV: "1" }, logger,
    registry: () => initialRegistry(["claude"]), catalog,
    scenarioPath: (m) => (m === "p1" || m === "p2" ? join(SCEN, `${m}.json`) : null),
    run: (o) => { const r = runStoredSession(o); runs.push(r); return r; },
    ...extra,
  });
}

const linkTransport = (text: () => string) => {
  const t = { requests: 0, transport: undefined as unknown as UrlTransport };
  t.transport = {
    async resolve() { return [{ address: "93.184.215.14", family: 4 }]; },
    async request(): Promise<UrlResponse> {
      t.requests++;
      const body = text();
      return { status: 200, headers: { "content-type": "text/plain" }, body: (async function* () { yield new TextEncoder().encode(body); })(), destroy() {} };
    },
  };
  return t;
};

describe("createLauncher", () => {
  it("template: session created, roles from the request, names, frame", async () => {
    const { id } = await make().start({ ...ok, participants: [scripted("  Скептик ", "p1"), scripted("", "p2")] });
    const stored = readSession(dir, id);
    expect(stored).not.toBeNull();
    const s = stored!.state.session!;
    expect(s.origin).toBe("desktop");
    expect(s).not.toHaveProperty("ownerWait");
    expect(s.framing).toBe(catalog().templates.find((t) => t.id === "pricing")!.framing);
    expect(s.participants.map((p) => p.role)).toEqual(["Скептик", null]);
    expect(s.participants.map((p) => p.model)).toEqual(["p1", "p2"]);
    expect(s.participants.map((p) => p.name)).toEqual(rosterNames(ok.participants, [{ id: "scripted", label: scriptedProviderLabel(), defaultModel: null }]));
    expect(logs.join("\n")).toContain("template pricing, participants 2, round limit 3");
    expect(logs.find((m) => m.startsWith("Session start from the app:"))).toMatch(/, owner wait: none$/);
  });

  describe("owner wait", () => {
    it.each([
      [true, true, 60, { pauseAfterRound: true, waitForOwner: true, timeoutSec: 60 }, "pause after round, answer to a question, timeout 60 s"],
      [true, false, 60, { pauseAfterRound: true, timeoutSec: 60 }, "pause after round, timeout 60 s"],
      [false, true, 60, { waitForOwner: true, timeoutSec: 60 }, "answer to a question, timeout 60 s"],
      [true, false, 1, { pauseAfterRound: true, timeoutSec: 1 }, "pause after round, timeout 1 s"],
      [false, true, OWNER_WAIT_MAX_SEC, { waitForOwner: true, timeoutSec: OWNER_WAIT_MAX_SEC }, `answer to a question, timeout ${OWNER_WAIT_MAX_SEC} s`],
    ])("режимы %s/%s, срок %s: настройки сессии и лог", async (pauseAfterRound, waitForOwner, timeoutSec, want, log) => {
      let session!: Session;
      const l = make({ run: async (o) => { session = o.session; o.onEvent?.({} as never, {} as never); return {} as never; } });
      await l.start({ ...ok, ownerWait: { pauseAfterRound, waitForOwner, timeoutSec } });
      expect(session.ownerWait).toEqual(want);
      expect(logs.find((m) => m.startsWith("Session start from the app:"))?.endsWith(`, owner wait: ${log}`)).toBe(true);
    });

    const enabled = { pauseAfterRound: true, waitForOwner: true, timeoutSec: 60 };
    it.each([
      ["нулевой срок", { ...enabled, timeoutSec: 0 }, `timeoutSec — целое число от 1 до ${OWNER_WAIT_MAX_SEC}`],
      ["срок выше границы", { ...enabled, timeoutSec: OWNER_WAIT_MAX_SEC + 1 }, `timeoutSec — целое число от 1 до ${OWNER_WAIT_MAX_SEC}`],
      ["дробный срок", { ...enabled, timeoutSec: 1.5 }, `timeoutSec — целое число от 1 до ${OWNER_WAIT_MAX_SEC}`],
      ["срок строкой", { ...enabled, timeoutSec: "60" }, `timeoutSec — целое число от 1 до ${OWNER_WAIT_MAX_SEC}`],
      ["оба режима выключены", { ...enabled, pauseAfterRound: false, waitForOwner: false }, "нужен хотя бы один включённый режим"],
      ["пауза строкой", { ...enabled, pauseAfterRound: "да" }, "pauseAfterRound и waitForOwner — булевы значения"],
      ["ответ числом", { ...enabled, waitForOwner: 1 }, "pauseAfterRound и waitForOwner — булевы значения"],
      ["нет режима", { waitForOwner: true, timeoutSec: 60 }, "pauseAfterRound и waitForOwner — булевы значения"],
      ["нет срока", { pauseAfterRound: true, waitForOwner: true }, `timeoutSec — целое число от 1 до ${OWNER_WAIT_MAX_SEC}`],
      ["строка", "да", "ожидается объект"],
      ["null", null, "ожидается объект"],
      ["массив", [], "ожидается объект"],
    ])("отказ: %s, сессия и исполнитель не создаются", async (_n, ownerWait, msg) => {
      const registry = vi.fn(() => initialRegistry(["claude"]));
      const run = vi.fn<typeof runStoredSession>();
      await expect(make({ registry, run }).start({ ...ok, ownerWait })).rejects.toThrow(new LaunchError(`Некорректный запрос запуска: ownerWait — ${msg}.`));
      expect(registry).not.toHaveBeenCalled();
      expect(listSessions(dir)).toEqual([]);
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe("independent drafts", () => {
    const three = [scripted(null, "p1"), scripted(null, "p2"), scripted(null, "p3")];
    const mk = (run = vi.fn<typeof runStoredSession>()) => make({ run, scenarioPath: () => join(SCEN, "p1.json") });
    const started = async (extra: object) => {
      let session!: Session;
      await mk(vi.fn(async (o) => { session = o.session; o.onEvent?.({} as never, {} as never); return {} as never; })).start({ ...ok, participants: three, ...extra });
      return session;
    };
    const startLog = () => logs.find((m) => m.startsWith("Session start from the app:"));

    it("without drafts there is no phase", async () => {
      expect((await started({})).drafts).toBeUndefined();
      expect(startLog()).toContain("independent drafts: none");
    });

    it("drafts p2: the choice is saved, log", async () => {
      expect((await started({ drafts: { synthesizerId: "p2" } })).drafts).toEqual({ enabled: true, synthesizerId: "p2" });
      expect(startLog()).toContain("independent drafts: synthesizer p2");
    });

    it.each([
      ["p4 при трёх участниках", { synthesizerId: "p4" }],
      ["null", null],
      ["пустой объект", {}],
      ["x2", { synthesizerId: "x2" }],
      ["p0", { synthesizerId: "p0" }],
      ["число", { synthesizerId: 2 }],
      ["массив", []],
    ])("отказ: %s, исполнитель и сессия не создаются", async (_n, drafts) => {
      const run = vi.fn<typeof runStoredSession>();
      const registry = vi.fn(() => initialRegistry(["claude"]));
      await expect(make({ run, registry }).start({ ...ok, participants: three, drafts })).rejects.toBeInstanceOf(LaunchError);
      expect(registry).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(listSessions(dir)).toEqual([]);
    });
  });

  it("own topic: neutral frame", async () => {
    const { id } = await make().start({ ...ok, templateId: null, participants: [scripted(null, "p1"), scripted(null, "p2")] });
    expect(readSession(dir, id)?.state.session?.framing).toBe(catalog().neutralFraming);
  });

  it("double start: one id and one session; after finishing — a new one", async () => {
    const l = make();
    const input = { ...ok, participants: [scripted(null, "p1"), scripted(null, "p2")] };
    const [a, b] = await Promise.all([l.start(input), l.start(input)]);
    expect(a.id).toBe(b.id);
    expect(listSessions(dir)).toHaveLength(1);
    expect(logs).toContain("Repeated start request: the session already being created returned");
    const c = await l.start(input);
    expect(c.id).not.toBe(a.id);
    expect(listSessions(dir)).toHaveLength(2);
  });

  it.each([
    ["не объект", null],
    ["templateId число", { ...ok, templateId: 1 }],
    ["topic не строка", { ...ok, topic: 5 }],
    ["participants не массив", { ...ok, participants: "x" }],
    ["пустой providerId", { ...ok, participants: [{ providerId: "", model: "m", role: null }, scripted()] }],
    ["role число", { ...ok, participants: [{ providerId: "scripted", model: "p1", role: 1 }, scripted()] }],
    ["maxRounds дробное", { ...ok, maxRounds: 2.5 }],
  ])("кривая форма: %s", async (_n, input) => {
    await expect(make().start(input)).rejects.toThrow(/^Некорректный запрос запуска/);
    expect(listSessions(dir)).toEqual([]);
  });

  const two = [scripted(null, "p1"), scripted(null, "p2")];
  it.each([
    ["maxRounds 0", { ...ok, participants: two, maxRounds: 0 }, "Лимит кругов должен быть от 1 до 20."],
    ["maxRounds 21", { ...ok, participants: two, maxRounds: 21 }, "Лимит кругов должен быть от 1 до 20."],
    ["неизвестный провайдер", { ...ok, participants: [{ providerId: "nope", model: "m", role: null }, ...two] }, "Провайдер «nope» не найден в реестре."],
    ["неизвестный сценарий", { ...ok, participants: [scripted(null, "zzz"), ...two] }, "Сценарий «zzz» недоступен."],
  ])("ошибка: %s", async (_n, input, msg) => {
    await expect(make().start(input)).rejects.toThrow(new LaunchError(msg));
    expect(listSessions(dir)).toEqual([]);
  });

  it("scripted participant without COUNCIL_DEV: the error names COUNCIL_DEV (ru and en), no session created", async () => {
    for (const [lang, text] of [["ru", "Сценарные участники доступны только при COUNCIL_DEV=1."], ["en", "Scripted participants are available only with COUNCIL_DEV=1."]] as const) {
      setProcessLanguage(lang);
      try {
        await expect(make({ env: {} }).start({ ...ok, participants: two })).rejects.toThrow(new LaunchError(text));
        await expect(make({ env: {} }).start({ ...ok, participants: [scripted(null, "zzz"), ...two] })).rejects.toThrow(new LaunchError(text));
      } finally { setProcessLanguage("ru"); }
    }
    expect(listSessions(dir)).toEqual([]);
  });

  it("unavailable provider: name and reason", async () => {
    const inspect = (async () => ({ status: { available: false, reason: "нет бинарника" } })) as never;
    const input = { ...ok, participants: [{ providerId: "claude", model: "m", role: null }, ...two] };
    await expect(make({ inspect }).start(input)).rejects.toThrow("Провайдер «Claude Code» недоступен: нет бинарника");
    expect(listSessions(dir)).toEqual([]);
  });

  it("participants from a lineup: the provider is not in the registry — refusal, no sessions", async () => {
    let ran = false;
    const input = { ...ok, participants: [{ providerId: "gone", model: "m", role: "Критик" }, ...two] };
    await expect(make({ run: (() => { ran = true; return Promise.resolve({}); }) as never }).start(input)).rejects.toThrow("не найден в реестре");
    expect(listSessions(dir)).toEqual([]);
    expect(ran).toBe(false);
  });

  it("one participant and an unknown template", async () => {
    await expect(make().start({ ...ok, participants: [scripted(null, "p1")] })).rejects.toThrow();
    await expect(make().start({ ...ok, templateId: "нет-такого", participants: two })).rejects.toThrow(/нет-такого/);
    expect(listSessions(dir)).toEqual([]);
  });

  it("after an error the next start works", async () => {
    const l = make();
    await expect(l.start({ ...ok, maxRounds: 0 })).rejects.toThrow(LaunchError);
    const { id } = await l.start({ ...ok, participants: two });
    expect(readSession(dir, id)).not.toBeNull();
  });

  it("onChunk arrives with the session id; running() and onEnded", async () => {
    const chunks: [string, string][] = [];
    const ended: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const l = make({
      onChunk: (id, c) => chunks.push([id, c.text]),
      onEnded: (id) => ended.push(id),
      run: (o) => {
        const r = (async () => { o.onChunk?.({ participantId: "p1", turn: 1, attempt: 1, text: "т" }); o.onEvent?.({} as never, {} as never); await gate; return {} as never; })();
        runs.push(r);
        return r;
      },
    });
    const { id } = await l.start({ ...ok, participants: two });
    expect(chunks).toEqual([[id, "т"]]);
    expect(l.running()).toEqual([id]);
    release();
    await Promise.allSettled(runs);
    await new Promise((r) => setImmediate(r));
    expect(l.running()).toEqual([]);
    expect(ended).toEqual([id]);
  });

  it("onEnded is called on a run error too", async () => {
    const ended: string[] = [];
    const l = make({
      onEnded: (id) => ended.push(id),
      run: (o) => {
        const r = (async () => { o.onEvent?.({} as never, {} as never); throw new Error("сбой"); })();
        runs.push(r);
        return r;
      },
    });
    const { id } = await l.start({ ...ok, participants: two });
    await Promise.allSettled(runs);
    await new Promise((r) => setImmediate(r));
    expect(ended).toEqual([id]);
    expect(l.running()).toEqual([]);
  });

  describe("materials", () => {
    const MARK = "СЕКРЕТНАЯ-МЕТКА-77";
    const A = `Первый материал ${MARK}`;
    const B = "Второй материал";
    const TEXTS = [A, B];
    let src: string;
    beforeEach(() => {
      src = realpathSync(mkdtempSync(join(tmpdir(), "council-mat-")));
      writeFileSync(join(src, "a.txt"), A);
      writeFileSync(join(src, "b.txt"), B);
    });
    afterEach(() => rmSync(src, { recursive: true, force: true }));

    const draft = (limit = 100000) => {
      const d = createMaterialsDraft({ limits: () => ({ materialsChars: limit, materialsIgnore: [] }) });
      d.attach([join(src, "a.txt"), join(src, "b.txt")]);
      return d;
    };
    const withLimit = (n: number) => () => { const r = initialRegistry(["claude"]); return { ...r, defaults: { ...r.defaults, materialsChars: n } }; };
    const input = { ...ok, participants: [scripted(null, "p1"), scripted(null, "p2")] };

    it("a folder attached: a snapshot of all its files in the session and in workspace/, draft cleared", async () => {
      const d = createMaterialsDraft({ limits: () => ({ materialsChars: 100000, materialsIgnore: [] }) });
      d.attach([src]);
      const names = d.workspace().map((f) => f.name);
      expect(names).toHaveLength(2);
      const { id } = await make({ materials: d }).start({ ...input, useMaterials: true });
      await Promise.allSettled(runs);
      const created = readSession(dir, id)!.state.session as unknown as { workspace?: { files: number; chars: number } };
      expect(created.workspace).toEqual({ files: 2, chars: A.length + B.length });
      for (const n of names) expect(existsSync(join(dir, "sessions", id, "workspace", n))).toBe(true);
      expect(d.workspace()).toEqual([]);
    });

    it("excluded by rules: without include the session snapshot has no out/main.js, with include it does", async () => {
      const proj = join(src, "proj");
      mkdirSync(join(proj, "out"), { recursive: true });
      writeFileSync(join(proj, ".gitignore"), "out/\n");
      writeFileSync(join(proj, "a.txt"), "исходник");
      writeFileSync(join(proj, "out/main.js"), "собранный");
      const snapshot = async (giveBack: boolean) => {
        const d = createMaterialsDraft({ limits: () => ({ materialsChars: 100000, materialsIgnore: [] }) });
        d.attach([proj]);
        if (giveBack) d.returnIgnored("x1");
        const { id } = await make({ materials: d }).start({ ...input, useMaterials: true });
        await Promise.allSettled(runs);
        return id;
      };
      const without = await snapshot(false);
      expect(existsSync(join(dir, "sessions", without, "workspace", "proj/a.txt"))).toBe(true);
      expect(existsSync(join(dir, "sessions", without, "workspace", "proj/out/main.js"))).toBe(false);
      const given = await snapshot(true);
      expect(existsSync(join(dir, "sessions", given, "workspace", "proj/out/main.js"))).toBe(true);
    });

    it("folder only: a folder snapshot without initial materials", async () => {
      const d = createMaterialsDraft({ limits: () => ({ materialsChars: 1, materialsIgnore: [] }) }); // not a single file fits the limit
      d.attach([src]);
      expect(d.view().items).toEqual([]);
      const names = d.workspace().map((f) => f.name);
      expect(names).toHaveLength(2);
      const { id } = await make({ materials: d }).start({ ...input, useMaterials: true });
      await Promise.allSettled(runs);
      const created = readSession(dir, id)!.state.session as unknown as { materials?: unknown; workspace?: { files: number; chars: number } };
      expect(created.materials).toBeUndefined();
      expect(created.workspace).toEqual({ files: 2, chars: A.length + B.length });
      for (const n of names) expect(existsSync(join(dir, "sessions", id, "workspace", n))).toBe(true);
      expect(existsSync(join(dir, "sessions", id, "materials"))).toBe(false);
      expect(d.workspace()).toEqual([]);
    });

    it("only files attached: no folder snapshot", async () => {
      const { id } = await make({ materials: draft() }).start({ ...input, useMaterials: true });
      await Promise.allSettled(runs);
      expect((readSession(dir, id)!.state.session as unknown as { workspace?: unknown }).workspace).toBeUndefined();
      expect(existsSync(join(dir, "sessions", id, "workspace"))).toBe(false);
    });

    it("useMaterials: materials in the session and folder, draft cleared", async () => {
      const d = draft();
      const { id } = await make({ materials: d }).start({ ...input, useMaterials: true });
      await Promise.allSettled(runs);
      const stored = readSession(dir, id)!;
      const created = stored.state.session as unknown as { materials: Record<string, unknown>[] };
      expect(created.materials).toHaveLength(2);
      for (const m of created.materials) expect(Object.keys(m).sort()).toEqual(["chars", "id", "name", "sha256"]);
      TEXTS.forEach((t, i) => expect(readFileSync(join(dir, "sessions", id, "materials", `m${i + 1}.txt`), "utf8")).toBe(t));
      expect(d.take()).toEqual([]);
      expect(stored.state.status).toBe("consensus");
    });

    it.each([["не задан", {}], ["false", { useMaterials: false }]])("useMaterials %s: сессия без материалов, черновик цел", async (_n, extra) => {
      const d = draft();
      const { id } = await make({ materials: d }).start({ ...input, ...extra });
      await Promise.allSettled(runs);
      const created = readSession(dir, id)!.state.session as unknown as { materials?: unknown };
      expect(created.materials).toBeUndefined();
      expect(existsSync(join(dir, "sessions", id, "materials"))).toBe(false);
      expect(d.take()).toHaveLength(2);
    });

    it("useMaterials with an empty draft: as without materials", async () => {
      const d = createMaterialsDraft({ limits: () => ({ materialsChars: 100000, materialsIgnore: [] }) });
      const { id } = await make({ materials: d }).start({ ...input, useMaterials: true });
      await Promise.allSettled(runs);
      const created = readSession(dir, id)!.state.session as unknown as { materials?: unknown };
      expect(created.materials).toBeUndefined();
      expect(existsSync(join(dir, "sessions", id, "materials"))).toBe(false);
    });

    it("useMaterials unset or false with a non-empty draft: session without materials, draft intact", async () => {
      const d = draft();
      for (const extra of [{}, { useMaterials: false }]) {
        const { id } = await make({ materials: d }).start({ ...input, ...extra });
        await Promise.allSettled(runs);
        expect((readSession(dir, id)!.state.session as unknown as { materials?: unknown }).materials).toBeUndefined();
        expect(existsSync(join(dir, "sessions", id, "materials"))).toBe(false);
        expect(d.take()).toHaveLength(2);
      }
    });

    it("limit exceeded: LaunchError with numbers, no sessions, draft intact", async () => {
      const d = draft();
      const total = A.length + B.length;
      const err = await make({ materials: d, registry: withLimit(10) }).start({ ...input, useMaterials: true }).catch((e) => e);
      expect(err).toBeInstanceOf(LaunchError);
      expect(err.message).toContain(String(total));
      expect(err.message).toContain("10");
      expect(listSessions(dir)).toEqual([]);
      expect(d.take()).toHaveLength(2);
    });

    it("refusal before start (unknown scenario): draft intact", async () => {
      const d = draft();
      await expect(make({ materials: d }).start({ ...input, participants: [scripted(null, "zzz"), scripted(null, "p2")], useMaterials: true })).rejects.toThrow(LaunchError);
      expect(listSessions(dir)).toEqual([]);
      expect(d.take()).toHaveLength(2);
    });

    it("repeated press: one session, take once", async () => {
      const d = draft();
      let takes = 0;
      const counter = { take: () => { takes++; return d.take(); }, clear: () => d.clear() };
      const l = make({ materials: counter });
      const [a, b] = await Promise.all([l.start({ ...input, useMaterials: true }), l.start({ ...input, useMaterials: true })]);
      expect(a.id).toBe(b.id);
      expect(listSessions(dir)).toHaveLength(1);
      expect(takes).toBe(1);
    });

    it("useMaterials not boolean: refusal", async () => {
      await expect(make({ materials: draft() }).start({ ...input, useMaterials: "да" })).rejects.toThrow(/^Некорректный запрос запуска/);
      expect(listSessions(dir)).toEqual([]);
    });

    it("journal: count and size, without text and paths", async () => {
      await make({ materials: draft() }).start({ ...input, useMaterials: true });
      await Promise.allSettled(runs);
      const all = logs.join("\n");
      expect(all).toContain(`materials 2, size ${A.length + B.length}`);
      expect(all).not.toContain(MARK);
      expect(all).not.toContain(src);
    });
  });

  describe("start from a prepared set", () => {
    let src: string;
    beforeEach(() => {
      src = realpathSync(mkdtempSync(join(tmpdir(), "council-prep-")));
      writeFileSync(join(src, "README.md"), "# PREVIEW_OLD");
      mkdirSync(join(src, "src"));
      writeFileSync(join(src, "src/a.ts"), "export const a = 1;");
    });
    afterEach(() => rmSync(src, { recursive: true, force: true }));
    const input = { ...ok, participants: [scripted(null, "p1"), scripted(null, "p2")], useMaterials: true };
    const mk = (limit = 100000) => {
      const d = createMaterialsDraft({ limits: () => ({ materialsChars: limit, materialsIgnore: [] }) });
      d.attach([src]);
      return d;
    };
    const prepared = (d: ReturnType<typeof mk>) => previewMaterials({ dataDir: dir, logger, materials: d }, false);
    const noRun = () => { const run = vi.fn(); return { run: run as never, calls: run }; };
    const noSessions = () => expect(existsSync(join(dir, "sessions")) ? readdirSync(join(dir, "sessions")) : []).toEqual([]);

    it("source changed after preview: the session and participant requests take the set", async () => {
      const d = mk();
      const preview = prepared(d);
      writeFileSync(join(src, "README.md"), "# PREVIEW_NEW");
      const takeSpy = vi.spyOn(d, "take");
      const wsSpy = vi.spyOn(d, "workspace");
      const prompts: string[] = [];
      const run: typeof runStoredSession = (o) => {
        const drivers = Object.fromEntries(Object.entries(o.drivers).map(([k, drv]) => [k, { ...drv, call: (req: Parameters<typeof drv.call>[0]) => { prompts.push(req.prompt); return drv.call(req); } }]));
        const r = runStoredSession({ ...o, drivers });
        runs.push(r);
        return r;
      };
      const { id } = await make({ materials: d, run }).start({ ...input, preparedHandle: preview.handle });
      await Promise.allSettled(runs);
      expect(readFileSync(join(dir, "sessions", id, "materials", "m1.txt"), "utf8")).toContain("PREVIEW_OLD");
      expect(prompts.length).toBeGreaterThan(0);
      for (const p of prompts) {
        expect(p).toContain(preview.initial!);
        expect(p).toContain(preview.manifest!);
        expect(p).not.toContain("PREVIEW_NEW");
      }
      expect(takeSpy).not.toHaveBeenCalled();
      expect(wsSpy).not.toHaveBeenCalled();
      expect(logs.find((m) => m.startsWith("Session start from the app:"))).toContain(`, prepared set ${preview.handle}`);
    });

    it.each([
      ["удалён материал", (d: ReturnType<typeof mk>) => { d.remove("m1"); }],
    ])("устаревшая метка (%s): отказ, сессий нет", async (_n, change) => {
      const d = mk();
      const { handle } = prepared(d);
      change(d);
      const { run, calls } = noRun();
      await expect(make({ materials: d, run }).start({ ...input, preparedHandle: handle })).rejects.toThrow(/^Предпросмотр устарел.*Обновите предпросмотр\.$/);
      expect(calls).not.toHaveBeenCalled();
      noSessions();
      expect(logs).toContain("Start by a prepared set rejected: stale");
    });

    it("stale mark (limit changed): refusal", async () => {
      let limit = 100000;
      const d = createMaterialsDraft({ limits: () => ({ materialsChars: limit, materialsIgnore: [] }) });
      d.attach([src]);
      const { handle } = prepared(d);
      limit = 90000;
      const { run, calls } = noRun();
      await expect(make({ materials: d, run }).start({ ...input, preparedHandle: handle })).rejects.toThrow(/^Предпросмотр устарел/);
      expect(calls).not.toHaveBeenCalled();
      noSessions();
    });

    it.each([
      ["unknown", () => "0123456789abcdef0123456789abcdef"],
      ["invalid", () => "../sessions/x"],
      ["corrupt", (d: ReturnType<typeof mk>) => {
        const { handle } = prepared(d);
        const p = join(dir, "prepared-materials", handle, "set.json");
        const b = readFileSync(p);
        b[b.length - 3] = b[b.length - 3] === 0x78 ? 0x79 : 0x78;
        writeFileSync(p, b);
        return handle;
      }],
      ["expired", (d: ReturnType<typeof mk>) => savePreparedMaterials(dir, d.snapshot(), { now: () => new Date(Date.now() - 25 * 3600 * 1000) }).id],
    ])("набор %s: отказ с причиной и подсказкой, сессий нет", async (problem, handleOf) => {
      const d = mk();
      const handle = handleOf(d);
      const { run, calls } = noRun();
      const err = await make({ materials: d, run }).start({ ...input, preparedHandle: handle }).catch((e) => e);
      expect(err).toBeInstanceOf(LaunchError);
      expect(err.message).toMatch(/\. Обновите предпросмотр\.$/);
      expect(err.message.length).toBeGreaterThan("Обновите предпросмотр.".length + 2);
      expect(calls).not.toHaveBeenCalled();
      noSessions();
      expect(logs).toContain(`Start by a prepared set rejected: ${problem}`);
    });

    it("preparedHandle not a string: refusal", async () => {
      await expect(make({ materials: mk() }).start({ ...input, preparedHandle: 5 })).rejects.toThrow(/^Некорректный запрос запуска/);
      noSessions();
    });
  });

  describe("rerun", () => {
    const input = { ...ok, participants: [scripted(null, "p1"), scripted(null, "p2")] };
    const withCatalog = (c: () => ReturnType<typeof catalog>) => make({ catalog: c });
    const changed = () => { const c = catalog(); return { ...c, neutralFraming: "ДРУГАЯ-НЕЙТРАЛЬНАЯ", templates: c.templates.map((t) => (t.id === "pricing" ? { ...t, framing: "ИЗМЕНЁННАЯ-РАМКА" } : t)) }; };
    const removed = () => { const c = catalog(); return { ...c, templates: c.templates.filter((t) => t.id !== "pricing") }; };
    const framingOf = (id: string) => readSession(dir, id)!.state.session!.framing;
    const past = async (extra: object = {}) => {
      const { id } = await make().start({ ...input, ...extra });
      await Promise.allSettled(runs);
      return { id, framing: framingOf(id) };
    };

    it("template changed: the frame of the previous session, templateId kept", async () => {
      const p = await past();
      const { id } = await withCatalog(changed).start({ ...input, framingFrom: p.id });
      const s = readSession(dir, id)!.state.session!;
      expect(s.framing).toBe(p.framing);
      expect(s.framing).not.toBe("ИЗМЕНЁННАЯ-РАМКА");
      expect(s.templateId).toBe("pricing");
    });

    it("template deleted, templateId null: the frame of the previous session, without a template", async () => {
      const p = await past();
      const { id } = await withCatalog(removed).start({ ...input, templateId: null, framingFrom: p.id });
      const s = readSession(dir, id)!.state.session!;
      expect(s.framing).toBe(p.framing);
      expect(s.templateId).toBeNull();
    });

    it("template deleted, templateId remained (race): the start goes through without a template", async () => {
      const p = await past();
      const { id } = await withCatalog(removed).start({ ...input, framingFrom: p.id });
      const s = readSession(dir, id)!.state.session!;
      expect(s.framing).toBe(p.framing);
      expect(s.templateId).toBeNull();
    });

    it("own topic: the neutral frame of the previous session, not the current one", async () => {
      const p = await past({ templateId: null });
      const { id } = await withCatalog(changed).start({ ...input, templateId: null, framingFrom: p.id });
      expect(framingOf(id)).toBe(p.framing);
      expect(framingOf(id)).not.toBe("ДРУГАЯ-НЕЙТРАЛЬНАЯ");
    });

    it("the previous session does not change, the id is new", async () => {
      const p = await past();
      const snap = () => ({ log: readFileSync(join(dir, "sessions", p.id, "events.jsonl"), "utf8"), files: readdirSync(join(dir, "sessions", p.id)).sort() });
      const before = snap();
      const { id } = await make().start({ ...input, framingFrom: p.id });
      await Promise.allSettled(runs);
      expect(id).not.toBe(p.id);
      expect(snap()).toEqual(before);
      expect(before.log.split("\n").filter(Boolean).length).toBe(snap().log.split("\n").filter(Boolean).length);
    });

    it("nonexistent session: LaunchError, no new sessions", async () => {
      const err = await make().start({ ...input, framingFrom: "20200101-000000-aaaaaa" }).catch((e) => e);
      expect(err).toBeInstanceOf(LaunchError);
      expect(err.message).toContain("не найдена");
      expect(listSessions(dir)).toEqual([]);
    });

    it.each([["число", 5], ["недопустимый id", "../x"], ["пустая строка", ""]])("framingFrom %s: отказ формы", async (_n, v) => {
      await expect(make().start({ ...input, framingFrom: v })).rejects.toThrow(/^Некорректный запрос запуска/);
      expect(listSessions(dir)).toEqual([]);
    });

    it("without framingFrom with a changed template: the frame of the current template", async () => {
      const { id } = await withCatalog(changed).start(input);
      expect(framingOf(id)).toBe("ИЗМЕНЁННАЯ-РАМКА");
    });

    it("with materials: the frame of the previous session and the materials, draft cleared", async () => {
      const p = await past();
      const src = realpathSync(mkdtempSync(join(tmpdir(), "council-mat-")));
      try {
        writeFileSync(join(src, "a.txt"), "Материал");
        const d = createMaterialsDraft({ limits: () => ({ materialsChars: 100000, materialsIgnore: [] }) });
        d.attach([join(src, "a.txt")]);
        const { id } = await make({ catalog: changed, materials: d }).start({ ...input, framingFrom: p.id, useMaterials: true });
        await Promise.allSettled(runs);
        const s = readSession(dir, id)!.state.session as unknown as { framing: string; materials: unknown[] };
        expect(s.framing).toBe(p.framing);
        expect(s.materials).toHaveLength(1);
        expect(d.take()).toEqual([]);
      } finally { rmSync(src, { recursive: true, force: true }); }
    });

    it("repeated press: one new session", async () => {
      const p = await past();
      const l = make();
      const [a, b] = await Promise.all([l.start({ ...input, framingFrom: p.id }), l.start({ ...input, framingFrom: p.id })]);
      expect(a.id).toBe(b.id);
      expect(listSessions(dir)).toHaveLength(2);
    });

    it("journal: the previous session id, without the frame text", async () => {
      const p = await past();
      logs.length = 0;
      await make().start({ ...input, framingFrom: p.id });
      const line = logs.find((l) => l.startsWith("Session start from the app"))!;
      expect(line).toContain(`framing from session ${p.id}`);
      expect(line).not.toContain(p.framing);
    });
  });
  describe("token ceiling", () => {
    const CAP_SCEN = join(import.meta.dirname, "../../../../packages/core/scenarios");
    const capPath = (m: string) => (m === "token-cap/p1.json" || m === "token-cap/p2.json" ? join(CAP_SCEN, m) : null);
    const people = [scripted(null, "token-cap/p1.json"), scripted(null, "token-cap/p2.json")];
    const input = { templateId: null, topic: "Тема", participants: people, maxRounds: 10 };
    const withCap = (n: number | undefined) => () => ({ ...initialRegistry(["claude"]), defaults: { ...initialRegistry(["claude"]).defaults, ...(n !== undefined ? { maxTotalTokens: n } : {}) } });
    const events = (id: string) => readSession(dir, id)!.state;
    const journal = (id: string) => readFileSync(join(dir, "sessions", id, "events.jsonl"), "utf8");

    it("number: the session has a ceiling, stop with reason token_cap, a journal line", async () => {
      const { id } = await make({ scenarioPath: capPath }).start({ ...input, maxTotalTokens: 1200 });
      await Promise.allSettled(runs);
      const stored = readSession(dir, id)!;
      expect(stored.state.session?.limits.maxTotalTokens).toBe(1200);
      expect(stored.status).toBe("stopped");
      expect(stored.state.finish?.reason).toBe("token_cap");
      expect(logs.join("\n")).toContain("token cap 1200");
    });

    it("null with one set in the registry: the session has no ceiling", async () => {
      const { id } = await make({ scenarioPath: capPath, registry: withCap(20000) }).start({ ...input, maxTotalTokens: null, maxRounds: 1 });
      await Promise.allSettled(runs);
      expect(events(id).session?.limits.maxTotalTokens).toBeUndefined();
      expect(logs.join("\n")).toContain("no token cap");
    });

    it("without the field the registry value is taken", async () => {
      const { id } = await make({ scenarioPath: capPath, registry: withCap(20000) }).start({ ...input, maxRounds: 1 });
      await Promise.allSettled(runs);
      expect(events(id).session?.limits.maxTotalTokens).toBe(20000);
    });

    it.each([["ноль", 0], ["дробное", 1.5], ["строка", "5"]])("кривое значение: %s", async (_n, v) => {
      await expect(make().start({ ...input, maxTotalTokens: v })).rejects.toThrow(/^Некорректный запрос запуска/);
      expect(listSessions(dir)).toEqual([]);
    });

    describe("resume", () => {
      async function stopped() {
        const l = make({ scenarioPath: capPath });
        const { id } = await l.start({ ...input, maxTotalTokens: 1200 });
        await Promise.allSettled(runs);
        return { l, id };
      }

      it("without a ceiling in the request — refusal with the engine numbers, journal unchanged", async () => {
        const { l, id } = await stopped();
        const before = journal(id);
        const e = await l.resume(id, 3).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(Error);
        expect((e as Error).message).toContain("1200");
        expect((e as Error).message).toContain("1500");
        expect(journal(id)).toBe(before);
      });

      it("ceiling not above the spend — a \"not above\" refusal", async () => {
        const { l, id } = await stopped();
        const before = journal(id);
        await expect(l.resume(id, 3, 1500)).rejects.toThrow(/не выше/);
        expect(journal(id)).toBe(before);
      });

      it("new ceiling accepted: session_resumed with it", async () => {
        const { l, id } = await stopped();
        await l.resume(id, 3, 2500);
        await Promise.allSettled(runs);
        const r = journal(id).split("\n").filter(Boolean).map((x) => JSON.parse(x) as { type: string; maxTotalTokens?: number | null }).filter((e) => e.type === "session_resumed");
        expect(r.map((e) => e.maxTotalTokens)).toEqual([2500]);
      });

      it("null removes the ceiling", async () => {
        const { l, id } = await stopped();
        await l.resume(id, 1, null);
        await Promise.allSettled(runs);
        const r = journal(id).split("\n").filter(Boolean).map((x) => JSON.parse(x) as { type: string; maxTotalTokens?: number | null }).filter((e) => e.type === "session_resumed");
        expect(r.map((e) => e.maxTotalTokens)).toEqual([null]);
      });

      it("zero — LaunchError", async () => {
        const { l, id } = await stopped();
        await expect(l.resume(id, 3, 0)).rejects.toBeInstanceOf(LaunchError);
      });
    });
  });
});

describe("language of start refusals", () => {
  let src: string;
  beforeEach(() => {
    src = realpathSync(mkdtempSync(join(tmpdir(), "council-lang-")));
    writeFileSync(join(src, "a.txt"), "data");
  });
  afterEach(() => { setProcessLanguage("ru"); rmSync(src, { recursive: true, force: true }); });
  const two = [scripted(null, "p1"), scripted(null, "p2")];
  const en = { ...ok, topic: "Topic", participants: two };
  const fail = async (input: unknown, extra: Partial<Parameters<typeof createLauncher>[0]> = {}) => (await make(extra).start(input).catch((e: unknown) => e)) as LaunchError;
  const mkDraft = () => { const d = createMaterialsDraft({ limits: () => ({ materialsChars: 100000, materialsIgnore: [] }) }); d.attach([src]); return d; };
  const noCyr = (e: LaunchError) => expect(e.message).not.toMatch(/[А-Яа-яЁё]/);

  it.each([
    ["кривой запрос", { ...en, topic: 5 }, "Invalid launch request: topic must be a string."],
    ["участник без модели", { ...en, participants: [{ providerId: "scripted", model: "", role: null }] }, "Invalid launch request: participant 1: non-empty providerId and model are required."],
    ["ownerWait без режима", { ...en, ownerWait: { pauseAfterRound: false, waitForOwner: false, timeoutSec: 5 } }, "Invalid launch request: ownerWait: at least one mode must be enabled."],
    ["лимит кругов", { ...en, maxRounds: 99 }, "The round limit must be from 1 to 20."],
    ["неизвестный провайдер", { ...en, participants: [{ providerId: "nope", model: "m", role: null }, ...two] }, "Provider “nope” not found in the registry."],
    ["недоступный сценарий", { ...en, participants: [scripted(null, "zzz"), ...two] }, "Scenario “zzz” is unavailable."],
    ["нет прошлой сессии", { ...en, framingFrom: "20260101-000000-aaaaaa" }, "The previous session 20260101-000000-aaaaaa was not found: there is no framing to take."],
  ])("en: %s", async (_n, input, text) => {
    setProcessLanguage("en");
    const e = await fail(input);
    expect(e).toBeInstanceOf(LaunchError);
    expect(e.message).toBe(text);
    expect(e.code).toBeUndefined();
    noCyr(e);
  });

  it("en: provider unavailable, the core reason verbatim (including Russian)", async () => {
    setProcessLanguage("en");
    const reason = async (r?: string) => fail({ ...en, participants: [{ providerId: "claude", model: "default", role: null }, ...two] }, { inspect: (async () => ({ status: { available: false, ...(r ? { reason: r } : {}) } })) as never });
    const a = await reason("нет бинарника");
    expect(a.message).toBe("Provider “Claude Code” is unavailable: нет бинарника");
    expect(a.code).toBeUndefined();
    const b = await reason();
    expect(b.message).toBe("Provider “Claude Code” is unavailable: reason unknown");
    noCyr(b);
  });

  it("en: resume with a bad round count and ceiling", async () => {
    setProcessLanguage("en");
    const l = make();
    const a = (await l.resume("x", 0).catch((e: unknown) => e)) as LaunchError;
    expect(a.message).toBe("The number of rounds must be an integer from 1 to 20.");
    const b = (await l.resume("x", 2, 0).catch((e: unknown) => e)) as LaunchError;
    expect(b.message).toBe("The new token cap must be an integer of 1 or more.");
  });

  it("en: a repeated resume with other parameters", async () => {
    setProcessLanguage("en");
    const l = make();
    const first = l.resume("20260101-000000-aaaaaa", 2).catch(() => {});
    const e = (await l.resume("20260101-000000-aaaaaa", 3).catch((x: unknown) => x)) as LaunchError;
    expect(e.message).toBe("Resuming this session is already starting with different parameters. Wait for it to start and try again.");
    await first;
  });

  it("en: stale preview and a set that failed to load — text and code", async () => {
    setProcessLanguage("en");
    const d = mkDraft();
    const { handle } = previewMaterials({ dataDir: dir, logger, materials: d }, false);
    d.remove("m1");
    const stale = await fail({ ...en, useMaterials: true, preparedHandle: handle }, { materials: d });
    expect(stale.message).toBe("The preview is outdated: the set of materials or their limit has changed. Refresh the preview.");
    expect(stale.code).toBe(PREVIEW_RETRY_CODE);
    noCyr(stale);
    const missing = await fail({ ...en, useMaterials: true, preparedHandle: "0123456789abcdef0123456789abcdef" }, { materials: d });
    expect(missing.message).toMatch(/ Refresh the preview\.$/);
    expect(missing.code).toBe(PREVIEW_RETRY_CODE);
  });

  it("the code on both set refusals in ru too", async () => {
    const d = mkDraft();
    const { handle } = previewMaterials({ dataDir: dir, logger, materials: d }, false);
    d.remove("m1");
    const stale = await fail({ ...ok, participants: two, useMaterials: true, preparedHandle: handle }, { materials: d });
    expect(stale.message).toMatch(/^Предпросмотр устарел.*Обновите предпросмотр\.$/);
    expect(stale.code).toBe(PREVIEW_RETRY_CODE);
    const missing = await fail({ ...ok, participants: two, useMaterials: true, preparedHandle: "0123456789abcdef0123456789abcdef" }, { materials: d });
    expect(missing.code).toBe(PREVIEW_RETRY_CODE);
  });

  it("language change between two refusals without recreating the launcher", async () => {
    const l = make();
    setProcessLanguage("en");
    const a = (await l.start({ ...en, maxRounds: 99 }).catch((e: unknown) => e)) as LaunchError;
    setProcessLanguage("ru");
    const b = (await l.start({ ...en, maxRounds: 99 }).catch((e: unknown) => e)) as LaunchError;
    expect(a.message).toBe("The round limit must be from 1 to 20.");
    expect(b.message).toBe("Лимит кругов должен быть от 1 до 20.");
  });

  it("the scripted participant name is recorded in the start language and does not change after a language change", async () => {
    setProcessLanguage("en");
    const { id } = await make().start(en);
    await Promise.allSettled(runs);
    const names = readSession(dir, id)!.state.session!.participants.map((p) => p.name);
    expect(names).toEqual(["Scripted (p1)", "Scripted (p2)"]);
    setProcessLanguage("ru");
    expect(readSession(dir, id)!.state.session!.participants.map((p) => p.name)).toEqual(names);
    expect(getProcessLanguage()).toBe("ru");
  });

  it.each([["en", "Scripted"], ["ru", "Сценарный"]] as const)("замена участника при продолжении (%s): имя добавленного записано на языке момента замены", async (lang, label) => {
    const resp = (stance: string, solution: string | null) => ({ response: { stance, reasoning: "r", solution, answers: [], questions: [] } });
    const agree = resp("agree", null);
    const env = { COUNCIL_DEV: "1" };
    const cat = join(dir, "catalog");
    mkdirSync(cat);
    writeFileSync(join(cat, "cat.json"), JSON.stringify({ steps: [agree, agree] }));
    const f1 = join(dir, "r-p1.json");
    writeFileSync(f1, JSON.stringify({ steps: [agree, agree] }));
    const session = createSession({
      topic: "Тема", framing: "", origin: "desktop", limits: { maxRounds: 1, turnTimeoutSec: 30, contextChars: 20000 },
      participants: [f1, "r-p2.json"].map((model, i) => ({ name: `N${i + 1}`, providerId: "scripted", model, role: null })),
    }, { maxParticipants: 8, id: "20260101-000000-bbbbbb" });
    await runStoredSession({ session, drivers: { p1: createScriptedDriver({ steps: [resp("amend", "v1")] }, env), p2: createScriptedDriver({ steps: [{ error: "fatal", retryable: false }] }, env) }, dataDir: dir });
    expect(readSession(dir, session.id)!.status).toBe("failed");
    setProcessLanguage(lang);
    await make({ scenarioPath: (m) => (m === "cat.json" ? join(cat, m) : null) }).resume(session.id, 2, undefined, [{ participantId: "p2", providerId: "scripted", model: "cat.json" }]);
    await Promise.allSettled(runs);
    await new Promise((r) => setTimeout(r, 700));
    const name = () => (readEvents(dir, session.id)!.events.filter((e) => e.type === "session_resumed") as unknown as { replacements: { participant: { name: string } }[] }[]).flatMap((e) => e.replacements).map((r) => r.participant.name).join();
    expect(name()).toBe(`${label} (cat.json)`);
    setProcessLanguage(lang === "en" ? "ru" : "en");
    expect(name()).toBe(`${label} (cat.json)`);
  });
});

describe("start with a link", () => {
  const input = { ...ok, participants: [scripted(null, "p1"), scripted(null, "p2")], useMaterials: true };
  const draftWith = async (text: () => string) => {
    const t = linkTransport(text);
    const d = createMaterialsDraft({ limits: () => ({ materialsChars: 1000, materialsIgnore: [] }), transport: t.transport });
    await d.addUrl("https://example.org/doc?token=SECRET");
    return { t, d };
  };

  it("start from an accepted set with a link: the session sources.json contains the source, the transport is not called after adding", async () => {
    let text = "СТАРЫЙ-ТЕКСТ";
    const { t, d } = await draftWith(() => text);
    const preview = previewMaterials({ dataDir: dir, logger, materials: d }, false);
    text = "НОВЫЙ-ТЕКСТ";
    const { id } = await make({ materials: d }).start({ ...input, preparedHandle: preview.handle });
    await Promise.allSettled(runs);
    const sources = readMaterialSources(dir, id)!;
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ id: "m1", host: "example.org", pathname: "/doc" });
    expect(JSON.stringify(sources)).not.toContain("SECRET");
    expect(readFileSync(join(dir, "sessions", id, "materials", "m1.txt"), "utf8")).toContain("СТАРЫЙ-ТЕКСТ");
    expect(t.requests).toBe(1);
    expect(logs.find((m) => m.startsWith("Session start from the app:"))).toContain(", link sources 1");
  });

  it("start without accepting the set: sources.json is written", async () => {
    const { t, d } = await draftWith(() => "ТЕКСТ");
    const { id } = await make({ materials: d }).start(input);
    await Promise.allSettled(runs);
    expect(readMaterialSources(dir, id)).toMatchObject([{ id: "m1", host: "example.org", pathname: "/doc" }]);
    expect(t.requests).toBe(1);
  });
});

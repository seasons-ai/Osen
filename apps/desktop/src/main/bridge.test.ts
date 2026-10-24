import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getProcessLanguage, setProcessLanguage } from "@model-council/core/i18n";
import { LanguageRejectedError } from "./language.ts";
import { createAppearanceState } from "./appearance.ts";
import { OwnerMessageRejectedError, OwnerReleaseRejectedError, OwnerSelectionRejectedError, ResumeRejectedError, StopRejectedError } from "@model-council/core";
import type { SessionEvent, UrlResponse, UrlTransport } from "@model-council/core";
import type { UsageSummary } from "@model-council/core/protocol";
import type { RegistryView } from "../shared/setup.ts";
import { LaunchError } from "./launcher.ts";
import { createBridge } from "./bridge.ts";
import type { BridgeDeps } from "./bridge.ts";
import { UnknownClientError } from "./connections.ts";
import { PreviewError } from "./materials-preview.ts";
import { RerunError } from "./rerun.ts";
import { SettingsError, createSettings } from "./settings.ts";
import { BRIDGE_ACTIONS } from "../shared/bridge.ts";
import { createCliTransition } from "./cli-transition.ts";
import { installVersions, pinsBytes, record } from "./cli-transition.testutil.ts";
import { initialRegistry, writeRegistry } from "@model-council/core";
import { readFileSync } from "node:fs";
import { createMaterialsDraft } from "./materials.ts";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUMMARY = { from: "2026-10-08", to: "2026-10-09", groups: [], total: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, unreadable: 0, truncated: 0 } as unknown as UsageSummary;

function setup(over: Partial<BridgeDeps> = {}) {
  const stops: ReturnType<typeof vi.fn>[] = [];
  const handlers: ((e: SessionEvent) => void)[] = [];
  const deps: BridgeDeps = {
    listSessions: vi.fn(() => []),
    sessionExists: vi.fn((id: string) => id !== "missing"),
    sessionDrafts: vi.fn(() => []),
    usageSummary: vi.fn(() => SUMMARY),
    watchSession: vi.fn((_id, onEvent) => {
      const stop = vi.fn();
      stops.push(stop);
      handlers.push(onEvent);
      return stop;
    }),
    notices: vi.fn(() => ["n"]),
    listTemplates: vi.fn(() => ({ templates: [], errors: [] })),
    registry: vi.fn(async () => ({ providers: [], scenarios: null }) as unknown as RegistryView),
    lineups: vi.fn(() => ({ lineups: [], error: null })),
    saveLineup: vi.fn(async () => ({ ok: true as const, id: "l1", name: "A" })),
    startSession: vi.fn(async () => ({ id: "s1" })),
    lastParticipants: vi.fn(() => null),
    resumeOptions: vi.fn(async () => ({ allowed: true }) as never),
    resumeSession: vi.fn(async () => ({ droppedOwnerRequests: ["р"] })),
    stopSession: vi.fn(),
    sendOwnerMessage: vi.fn(() => ({ requestId: "r1" })),
    continueWait: vi.fn(() => ({ requestId: "r2" })),
    acceptVersion: vi.fn(() => ({ version: 2, statusAtSelection: "no_consensus", note: null, ts: "2026-01-01T00:00:00Z" }) as never),
    previewMaterials: vi.fn(() => ({ handle: "h" }) as never),
    prepareRerun: vi.fn(() => ({ sessionId: "a" }) as never),
    copyText: vi.fn(),
    exportSession: vi.fn(async () => ({ path: "/x.md" })),
    setPinned: vi.fn(),
    language: { view: vi.fn(() => ({ language: "ru" as const, source: "default" as const, locked: false, damaged: false })), set: vi.fn((l: unknown) => ({ language: l as "en", source: "file" as const, locked: false, damaged: false })), invalidNotice: vi.fn(() => null) },
    appearance: { view: vi.fn(() => ({ mode: "dark" as const, lightTheme: "tuman" as const, theme: "osen" as const })), set: vi.fn((i: unknown) => ({ mode: "light" as const, lightTheme: (i as { lightTheme: "len" }).lightTheme, theme: (i as { lightTheme: "len" }).lightTheme })), systemChanged: vi.fn(), background: vi.fn(() => "#17130F") },
    settings: {
      view: vi.fn(async () => "view" as never),
      recheck: vi.fn(async () => "recheck" as never),
      saveProvider: vi.fn(async () => "saveProvider" as never),
      deleteProvider: vi.fn(async () => "deleteProvider" as never),
      saveModels: vi.fn(async () => "saveModels" as never),
      refreshModels: vi.fn(async () => "refreshModels" as never),
      testProvider: vi.fn(async () => "testProvider" as never),
      saveDefaults: vi.fn(async () => "saveDefaults" as never),
      setTransitionPeriod: vi.fn(async () => "setTransitionPeriod" as never),
      switchCli: vi.fn(async () => "switchCli" as never),
      rollbackCli: vi.fn(async () => "rollbackCli" as never),
    },
    templates: {
      open: vi.fn(() => "open" as never),
      create: vi.fn(() => "create" as never),
      save: vi.fn(() => "save" as never),
      remove: vi.fn(),
    },
    materials: createMaterialsDraft({ limits: () => ({ materialsChars: 1000, materialsIgnore: ["node_modules"] }) }),
    pickMaterials: vi.fn(async () => null),
    connections: {
      view: vi.fn(async () => "view" as never),
      connect: vi.fn(async () => "connect" as never),
      update: vi.fn(async () => "update" as never),
      disconnect: vi.fn(async () => "disconnect" as never),
      check: vi.fn(async () => "check" as never),
      installCommand: vi.fn(async () => "installCommand" as never),
      removeCommand: vi.fn(async () => "removeCommand" as never),
      zprofileLine: vi.fn(() => "LINE"),
    },
    send: vi.fn(),
    logger: { info: vi.fn(), error: vi.fn() },
    ...over,
  };
  return { deps, bridge: createBridge(deps), stops, handlers };
}

describe("bridge: resume", () => {
  it("resumeOptions and resumeSession pass the result through", async () => {
    const { deps, bridge } = setup();
    expect(await bridge.call("resumeOptions", ["s1"])).toEqual({ ok: true, value: { allowed: true } });
    expect(await bridge.call("resumeSession", ["s1", 3])).toEqual({ ok: true, value: { droppedOwnerRequests: ["р"] } });
    expect(deps.resumeOptions).toHaveBeenCalledWith("s1", undefined, undefined);
    expect(deps.resumeSession).toHaveBeenCalledWith("s1", 3, undefined, undefined, undefined);
  });

  it("the owner message is forwarded; null is absence; a non-string is refused", async () => {
    const { deps, bridge } = setup();
    await bridge.call("resumeOptions", ["s1", undefined, "Consider the budget"]);
    await bridge.call("resumeOptions", ["s1", undefined, null]);
    await bridge.call("resumeSession", ["s1", 3, undefined, undefined, "Consider the budget"]);
    await bridge.call("resumeSession", ["s1", 3, undefined, undefined, null]);
    expect(deps.resumeOptions).toHaveBeenNthCalledWith(1, "s1", undefined, "Consider the budget");
    expect(deps.resumeOptions).toHaveBeenNthCalledWith(2, "s1", undefined, undefined);
    expect(deps.resumeSession).toHaveBeenNthCalledWith(1, "s1", 3, undefined, undefined, "Consider the budget");
    expect(deps.resumeSession).toHaveBeenNthCalledWith(2, "s1", 3, undefined, undefined, undefined);
    const bad = { ok: false, error: "Реплика владельца должна быть строкой." };
    expect(await bridge.call("resumeOptions", ["s1", undefined, 5])).toEqual(bad);
    expect(await bridge.call("resumeSession", ["s1", 3, undefined, undefined, { a: 1 }])).toEqual(bad);
    expect(deps.resumeOptions).toHaveBeenCalledTimes(2);
    expect(deps.resumeSession).toHaveBeenCalledTimes(2);
  });

  it("third ceiling argument: number, null, absence", async () => {
    const { deps, bridge } = setup();
    await bridge.call("resumeSession", ["s1", 3, 2500]);
    await bridge.call("resumeSession", ["s1", 3, null]);
    await bridge.call("resumeSession", ["s1", 3]);
    expect((deps.resumeSession as ReturnType<typeof vi.fn>).mock.calls).toEqual([["s1", 3, 2500, undefined, undefined], ["s1", 3, null, undefined, undefined], ["s1", 3, undefined, undefined, undefined]]);
  });

  it.each([[0], [1.5], ["5"], [-1]])("потолок %s отклоняется на мосту", async (cap) => {
    const { deps, bridge } = setup();
    expect(await bridge.call("resumeSession", ["s1", 3, cap])).toEqual({ ok: false, error: "Новый потолок токенов должен быть целым числом от 1" });
    expect(deps.resumeSession).not.toHaveBeenCalled();
  });

  it.each([["../x"], [5], [undefined]])("id %s отклоняется", async (id) => {
    const { deps, bridge } = setup();
    expect(await bridge.call("resumeOptions", [id])).toMatchObject({ ok: false });
    expect(await bridge.call("resumeSession", [id, 2])).toMatchObject({ ok: false });
    expect(deps.resumeOptions).not.toHaveBeenCalled();
    expect(deps.resumeSession).not.toHaveBeenCalled();
  });

  it.each([[0], [21], [1.5], ["2"], [undefined], [NaN]])("rounds %s отклоняется на мосту", async (rounds) => {
    const { deps, bridge } = setup();
    const r = await bridge.call("resumeSession", ["s1", rounds]);
    expect(r).toEqual({ ok: false, error: "Число кругов должно быть целым от 1 до 20." });
    expect(deps.resumeSession).not.toHaveBeenCalled();
  });

  it("engine refusal and failure arrive as { ok: false, error }", async () => {
    const reject = vi.fn(async () => { throw new ResumeRejectedError("consensus", "Согласие уже достигнуто."); });
    expect(await setup({ resumeSession: reject }).bridge.call("resumeSession", ["s1", 2])).toEqual({ ok: false, error: "Согласие уже достигнуто." });
    const boom = vi.fn(async () => { throw new Error("сбой"); });
    expect(await setup({ resumeOptions: boom }).bridge.call("resumeOptions", ["s1"])).toEqual({ ok: false, error: "сбой" });
  });
});

describe("bridge: owner choice", () => {
  it("acceptVersion passes the arguments and returns the result", async () => {
    const { deps, bridge } = setup();
    expect(await bridge.call("acceptVersion", ["s1", 2, "заметка"])).toMatchObject({ ok: true, value: { version: 2 } });
    expect(await bridge.call("acceptVersion", ["s1", 2, null])).toMatchObject({ ok: true });
    expect(await bridge.call("acceptVersion", ["s1", 2])).toMatchObject({ ok: true });
    expect((deps.acceptVersion as ReturnType<typeof vi.fn>).mock.calls).toEqual([["s1", 2, "заметка"], ["s1", 2, undefined], ["s1", 2, undefined]]);
  });
  it.each([["../x"], [5], [undefined]])("id %s отклоняется", async (id) => {
    const { deps, bridge } = setup();
    expect(await bridge.call("acceptVersion", [id, 1])).toMatchObject({ ok: false });
    expect(deps.acceptVersion).not.toHaveBeenCalled();
  });
  it.each([[0], [-1], [1.5], ["2"], [undefined], [NaN]])("номер %s отклоняется", async (v) => {
    const { deps, bridge } = setup();
    expect(await bridge.call("acceptVersion", ["s1", v])).toEqual({ ok: false, error: "Номер версии должен быть целым положительным числом." });
    expect(deps.acceptVersion).not.toHaveBeenCalled();
  });
  it.each([[5], [{}], [true]])("заметка %s отклоняется", async (n) => {
    const { deps, bridge } = setup();
    expect(await bridge.call("acceptVersion", ["s1", 1, n])).toEqual({ ok: false, error: "Заметка должна быть строкой." });
    expect(deps.acceptVersion).not.toHaveBeenCalled();
  });
  it("engine refusal arrives as { ok: false, error }, any other failure is passed through as text", async () => {
    const reject = vi.fn(() => { throw new OwnerSelectionRejectedError("busy", "Сессию s1 сейчас продолжает другой процесс: выбор не записан."); });
    expect(await setup({ acceptVersion: reject }).bridge.call("acceptVersion", ["s1", 1])).toEqual({ ok: false, error: "Сессию s1 сейчас продолжает другой процесс: выбор не записан." });
    const boom = vi.fn(() => { throw new Error("сбой"); });
    expect(await setup({ acceptVersion: boom }).bridge.call("acceptVersion", ["s1", 1])).toEqual({ ok: false, error: "сбой" });
  });
});

describe("bridge", () => {
  it.each([["evil"], [42], [undefined]])("неизвестное действие %s не выполняется", async (action) => {
    const { deps, bridge } = setup();
    const r = await bridge.call(action, []);
    expect(r).toMatchObject({ ok: false });
    expect(deps.logger.error).toHaveBeenCalled();
    expect(deps.listSessions).not.toHaveBeenCalled();
    expect(deps.watchSession).not.toHaveBeenCalled();
  });

  it("listSessions and notices return the deps values", async () => {
    const { bridge } = setup();
    expect(await bridge.call("listSessions", [])).toEqual({ ok: true, value: [] });
    expect(await bridge.call("notices", [])).toEqual({ ok: true, value: ["n"] });
  });

  it.each([["../x"], [5], [undefined], ["missing"]])("openSession(%s) отклоняется", async (id) => {
    const { deps, bridge } = setup();
    const r = await bridge.call("openSession", [id]);
    expect(r.ok).toBe(false);
    expect(deps.logger.error).toHaveBeenCalled();
    expect(deps.watchSession).not.toHaveBeenCalled();
  });

  it("sessionDrafts: an existing session returns what deps returned", async () => {
    const views = [{ draftId: "d1", participantId: "p1", attempts: 1, chars: 3, reasoning: "r", text: "abc", error: null }];
    const { deps, bridge } = setup({ sessionDrafts: vi.fn(() => views) });
    expect(await bridge.call("sessionDrafts", ["s1"])).toEqual({ ok: true, value: views });
    expect(deps.sessionDrafts).toHaveBeenCalledWith("s1");
  });

  it("sessionDrafts: an invalid id is rejected", async () => {
    const { deps, bridge } = setup();
    const r = await bridge.call("sessionDrafts", ["../x"]);
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toContain("Недопустимый идентификатор сессии");
    expect(deps.sessionDrafts).not.toHaveBeenCalled();
  });

  it("usageSummary: a valid period and from === to", async () => {
    const { deps, bridge } = setup();
    expect(await bridge.call("usageSummary", ["2026-10-08", "2026-10-09"])).toEqual({ ok: true, value: SUMMARY });
    expect(deps.usageSummary).toHaveBeenCalledWith("2026-10-08", "2026-10-09");
    expect((await bridge.call("usageSummary", ["2026-10-08", "2026-10-08"])).ok).toBe(true);
  });

  it("usageSummary: a wrong date format is rejected", async () => {
    const { deps, bridge } = setup();
    for (const args of [["09.10.2026", "2026-10-09"], ["2026-13-01", "2026-13-02"], ["2026-02-30", "2026-03-01"], [20261008, "2026-10-09"], ["2026-10-08"]]) {
      const r = await bridge.call("usageSummary", args);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).toContain("ГГГГ-ММ-ДД");
    }
    expect(deps.usageSummary).not.toHaveBeenCalled();
  });

  it("usageSummary: a start later than the end is rejected", async () => {
    const { deps, bridge } = setup();
    const r = await bridge.call("usageSummary", ["2026-10-09", "2026-10-08"]);
    expect(JSON.stringify(r)).toContain("Начало периода позже конца.");
    expect(r.ok).toBe(false);
    expect(deps.usageSummary).not.toHaveBeenCalled();
  });

  it("sessionDrafts: a nonexistent session", async () => {
    const { deps, bridge } = setup();
    const r = await bridge.call("sessionDrafts", ["missing"]);
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toContain("не найдена");
    expect(deps.sessionDrafts).not.toHaveBeenCalled();
  });

  it("reason text for a nonexistent session", async () => {
    expect(await setup().bridge.call("openSession", ["missing"])).toEqual({ ok: false, error: "Сессия missing не найдена" });
  });

  it("a repeated openSession stops the previous watch; events carry the id", async () => {
    const { deps, bridge, stops, handlers } = setup();
    await bridge.call("openSession", ["a"]);
    await bridge.call("openSession", ["b"]);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).not.toHaveBeenCalled();
    const event = { seq: 1 } as SessionEvent;
    handlers[1]!(event);
    expect(deps.send).toHaveBeenCalledWith({ type: "session-event", id: "b", event });
  });

  it("openId: null before opening, the id after openSession, null after closeSession", async () => {
    const { bridge } = setup();
    expect(bridge.openId()).toBeNull();
    await bridge.call("openSession", ["a"]);
    expect(bridge.openId()).toBe("a");
    await bridge.call("closeSession", []);
    expect(bridge.openId()).toBeNull();
  });

  it("closeSession and dispose stop", async () => {
    const { bridge, stops } = setup();
    await bridge.call("openSession", ["a"]);
    await bridge.call("closeSession", []);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    await bridge.call("openSession", ["b"]);
    bridge.dispose();
    bridge.dispose();
    expect(stops[1]).toHaveBeenCalledTimes(1);
  });

  it("exception in deps: log and ok:false", async () => {
    const boom = new Error("сломалось");
    const { deps, bridge } = setup({ listSessions: () => { throw boom; } });
    expect(await bridge.call("listSessions", [])).toEqual({ ok: false, error: "сломалось" });
    expect(deps.logger.error).toHaveBeenCalledWith(expect.any(String), boom);
  });

  it.each([["../x", true], [5, true], [undefined, false]])("setPinned(%s, %s) с неверным id отклоняется", async (id, pinned) => {
    const { deps, bridge } = setup();
    expect((await bridge.call("setPinned", [id, pinned])).ok).toBe(false);
    expect(deps.setPinned).not.toHaveBeenCalled();
  });

  it.each([["true"], [1], [null], [undefined]])("setPinned с pinned=%s (не boolean) отклоняется", async (pinned) => {
    const { deps, bridge } = setup();
    expect((await bridge.call("setPinned", ["s1", pinned])).ok).toBe(false);
    expect(deps.setPinned).not.toHaveBeenCalled();
  });

  it("setPinned: a nonexistent one cannot be pinned, can be unpinned", async () => {
    const { deps, bridge } = setup();
    expect(await bridge.call("setPinned", ["missing", true])).toEqual({ ok: false, error: "Сессия missing не найдена" });
    expect(deps.setPinned).not.toHaveBeenCalled();
    expect(await bridge.call("setPinned", ["missing", false])).toEqual({ ok: true, value: null });
    expect(deps.setPinned).toHaveBeenCalledWith("missing", false);
  });

  it("setPinned reaches deps, a storage error is returned as text", async () => {
    const { deps, bridge } = setup();
    expect(await bridge.call("setPinned", ["s1", true])).toEqual({ ok: true, value: null });
    expect(deps.setPinned).toHaveBeenCalledWith("s1", true);
    const bad = setup({ setPinned: () => { throw new Error("диск полон"); } });
    expect(await bad.bridge.call("setPinned", ["s1", true])).toEqual({ ok: false, error: "диск полон" });
  });

  it("new actions return the deps values", async () => {
    const { deps, bridge } = setup();
    expect(await bridge.call("listTemplates", [])).toEqual({ ok: true, value: { templates: [], errors: [] } });
    expect(await bridge.call("registry", [])).toMatchObject({ ok: true });
    expect(await bridge.call("startSession", [{}])).toEqual({ ok: true, value: { id: "s1" } });
    expect(await bridge.call("lastParticipants", [])).toEqual({ ok: true, value: null });
    expect(deps.registry).toHaveBeenCalledTimes(1);
  });

  it("startSession receives the first argument unchanged", async () => {
    const { deps, bridge } = setup();
    const input = { topic: "t", extra: [1] };
    await bridge.call("startSession", [input, "лишний"]);
    expect(deps.startSession).toHaveBeenCalledWith(input);
  });

  it.each([["startSession", [{}]], ["registry", []]] as const)("отклонённый промис %s: ok:false и лог", async (action, args) => {
    const { deps, bridge } = setup({ [action]: () => Promise.reject(new Error("отказ")) });
    expect(await bridge.call(action, [...args])).toEqual({ ok: false, error: "отказ" });
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it("a synchronous throw in listTemplates gives ok:false", async () => {
    const { bridge } = setup({ listTemplates: () => { throw new Error("битый шаблон"); } });
    expect(await bridge.call("listTemplates", [])).toEqual({ ok: false, error: "битый шаблон" });
  });

  it("stopSession: a bad id is rejected, a good one reaches deps", async () => {
    const { deps, bridge } = setup();
    expect((await bridge.call("stopSession", ["../x"])).ok).toBe(false);
    expect(deps.stopSession).not.toHaveBeenCalled();
    expect(await bridge.call("stopSession", ["a"])).toEqual({ ok: true, value: null });
    expect(deps.stopSession).toHaveBeenCalledWith("a");
  });

  it("stopSession: StopRejectedError gives the same reason without a stack in the log", async () => {
    const { deps, bridge } = setup({ stopSession: () => { throw new StopRejectedError("finished", "Сессия a уже завершена: done."); } });
    expect(await bridge.call("stopSession", ["a"])).toEqual({ ok: false, error: "Сессия a уже завершена: done." });
    expect(deps.logger.error).toHaveBeenCalledWith(expect.any(String), undefined);
  });

  describe("owner message", () => {
    it("success: the text is passed as typed, answerTo is not set", async () => {
      const { deps, bridge } = setup();
      expect(await bridge.call("sendOwnerMessage", ["a", "  привет  мир ", undefined])).toEqual({ ok: true, value: { requestId: "r1" } });
      expect(deps.sendOwnerMessage).toHaveBeenCalledWith("a", "  привет  мир ", undefined);
    });

    it("answer to a question: answerTo reaches deps", async () => {
      const { deps, bridge } = setup();
      expect((await bridge.call("sendOwnerMessage", ["a", "ответ", "q3"])).ok).toBe(true);
      expect(deps.sendOwnerMessage).toHaveBeenCalledWith("a", "ответ", "q3");
    });

    it.each([[""], ["   \n\t"]])("пустой текст %j отклонён", async (text) => {
      const { deps, bridge } = setup();
      expect(await bridge.call("sendOwnerMessage", ["a", text])).toEqual({ ok: false, error: "Реплика должна быть непустой." });
      expect(deps.sendOwnerMessage).not.toHaveBeenCalled();
    });

    it.each([
      ["a", 5, undefined],
      ["../x", "текст", undefined],
      ["a", "текст", 7],
      ["a", "текст", ""],
    ])("недопустимые аргументы %j %j %j отклонены", async (id, text, answerTo) => {
      const { deps, bridge } = setup();
      expect((await bridge.call("sendOwnerMessage", [id, text, answerTo])).ok).toBe(false);
      expect(deps.sendOwnerMessage).not.toHaveBeenCalled();
    });

    it.each([
      ["finished", "Сессия a уже завершена: consensus."],
      ["interrupted", "Сессия a прервана."],
      ["question_closed", "Вопрос q2 уже закрыт: остался без ответа."],
    ] as const)("отказ хранилища %s даёт ту же причину", async (reason, message) => {
      const { bridge } = setup({ sendOwnerMessage: () => { throw new OwnerMessageRejectedError(reason, message); } });
      expect(await bridge.call("sendOwnerMessage", ["a", "текст", "q2"])).toEqual({ ok: false, error: message });
    });

    it("the message text does not get into the log on success or refusal", async () => {
      const mark = "СЕКРЕТНАЯ-МЕТКА-77";
      const ok = setup();
      await ok.bridge.call("sendOwnerMessage", ["a", mark]);
      const bad = setup({ sendOwnerMessage: () => { throw new OwnerMessageRejectedError("finished", "Сессия a уже завершена: done."); } });
      await bad.bridge.call("sendOwnerMessage", ["a", mark]);
      for (const d of [ok.deps, bad.deps]) {
        const logged = JSON.stringify([(d.logger.info as ReturnType<typeof vi.fn>).mock.calls, (d.logger.error as ReturnType<typeof vi.fn>).mock.calls]);
        expect(logged).not.toContain(mark);
      }
    });
  });

  describe("releasing the owner wait", () => {
    it("success: identifiers are passed to the dependency, the request is returned", async () => {
      const { deps, bridge } = setup();
      expect(await bridge.call("continueWait", ["a", "w12"])).toEqual({ ok: true, value: { requestId: "r2" } });
      expect(deps.continueWait).toHaveBeenCalledWith("a", "w12");
    });

    it.each([["../x"], [5], [undefined]])("недопустимый идентификатор сессии %j отклонён", async (id) => {
      const { deps, bridge } = setup();
      expect(await bridge.call("continueWait", [id, "w1"])).toEqual({ ok: false, error: `Недопустимый идентификатор сессии: ${String(id)}` });
      expect(deps.continueWait).not.toHaveBeenCalled();
      expect(deps.logger.error).toHaveBeenCalledWith(expect.any(String), undefined);
    });

    it.each([[5], [null], [undefined], [""], ["1"], ["w0"], ["w1; rm"]])("недопустимый идентификатор ожидания %j отклонён", async (waitId) => {
      const { deps, bridge } = setup();
      expect(await bridge.call("continueWait", ["a", waitId])).toEqual({ ok: false, error: "Идентификатор ожидания должен иметь вид w1, w2, …" });
      expect(deps.continueWait).not.toHaveBeenCalled();
      expect(deps.logger.error).toHaveBeenCalledWith(expect.any(String), undefined);
    });

    it("stale wait: engine refusal gives the same reason without a stack in the log", async () => {
      const message = "Ожидание w1 уже снято: сейчас активно w2.";
      const { deps, bridge } = setup({ continueWait: () => { throw new OwnerReleaseRejectedError("stale_wait", message); } });
      expect(await bridge.call("continueWait", ["a", "w1"])).toEqual({ ok: false, error: message });
      expect(deps.logger.error).toHaveBeenCalledWith(expect.any(String), undefined);
    });

    it("an unrelated error is kept in the log as an exception", async () => {
      const error = new Error("сбой очереди");
      const { deps, bridge } = setup({ continueWait: () => { throw error; } });
      expect(await bridge.call("continueWait", ["a", "w1"])).toEqual({ ok: false, error: "сбой очереди" });
      expect(deps.logger.error).toHaveBeenCalledWith(expect.any(String), error);
    });
  });

  it("copyText: a non-string is rejected, a string is passed", async () => {
    const { deps, bridge } = setup();
    expect(await bridge.call("copyText", [5])).toEqual({ ok: false, error: "Текст для буфера обмена должен быть строкой" });
    expect(deps.copyText).not.toHaveBeenCalled();
    expect((await bridge.call("copyText", ["привет"])).ok).toBe(true);
    expect(deps.copyText).toHaveBeenCalledWith("привет");
  });

  it("exportSession: path, null and a bad id", async () => {
    const { deps, bridge } = setup();
    expect(await bridge.call("exportSession", ["a"])).toEqual({ ok: true, value: { path: "/x.md" } });
    (deps.exportSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    expect(await bridge.call("exportSession", ["a"])).toEqual({ ok: true, value: null });
    expect((await bridge.call("exportSession", ["../x"])).ok).toBe(false);
  });

  describe("streaming text", () => {
    const c = (turn: number, attempt: number, text: string) => ({ participantId: "p1", turn, attempt, text });
    const texts = (deps: BridgeDeps) => (deps.send as ReturnType<typeof vi.fn>).mock.calls.map((x) => x[0]).filter((e) => e.type === "turn-text");

    it("a chunk of the open session goes out with an offset; a new attempt starts at 0", async () => {
      const { deps, bridge } = setup();
      await bridge.call("openSession", ["a"]);
      bridge.chunk("a", c(1, 1, "аб"));
      bridge.chunk("a", c(1, 1, "вг"));
      bridge.chunk("a", c(1, 2, "д"));
      expect(texts(deps)).toEqual([
        { type: "turn-text", id: "a", turn: 1, attempt: 1, offset: 0, text: "аб" },
        { type: "turn-text", id: "a", turn: 1, attempt: 1, offset: 2, text: "вг" },
        { type: "turn-text", id: "a", turn: 1, attempt: 2, offset: 0, text: "д" },
      ]);
    });

    it("an unopened session accumulates; on openSession everything arrives with offset 0", async () => {
      const { deps, bridge } = setup();
      bridge.chunk("b", c(2, 1, "аб"));
      bridge.chunk("b", c(2, 1, "вг"));
      expect(texts(deps)).toEqual([]);
      await bridge.call("openSession", ["b"]);
      expect(texts(deps)).toEqual([{ type: "turn-text", id: "b", turn: 2, attempt: 1, offset: 0, text: "абвг" }]);
    });

    it("after ended nothing is accumulated; after closeSession chunks are not sent", async () => {
      const { deps, bridge } = setup();
      bridge.chunk("a", c(1, 1, "x"));
      bridge.ended("a");
      await bridge.call("openSession", ["a"]);
      expect(texts(deps)).toEqual([]);
      await bridge.call("closeSession", []);
      bridge.chunk("a", c(1, 1, "y"));
      expect(texts(deps)).toEqual([]);
    });
  });

  describe("settings", () => {
    it.each([
      ["settings", "view", []],
      ["recheckProviders", "recheck", []],
      ["saveProvider", "saveProvider", [{ id: null }]],
      ["deleteProvider", "deleteProvider", ["a"]],
      ["saveModels", "saveModels", ["a", ["m"]]],
      ["refreshModels", "refreshModels", ["a"]],
      ["testProvider", "testProvider", ["a", "m"]],
      ["saveDefaults", "saveDefaults", [{ maxRounds: 3 }]],
      ["setTransitionPeriod", "setTransitionPeriod", [14]],
      ["switchCli", "switchCli", ["claude", "2.1.300"]],
      ["rollbackCli", "rollbackCli", ["claude"]],
    ] as const)("%s делегирует в settings.%s", async (action, method, args) => {
      const { deps, bridge } = setup();
      expect(await bridge.call(action, [...args])).toEqual({ ok: true, value: method });
      expect(deps.settings[method]).toHaveBeenCalledWith(...args);
    });

    it("SettingsError reaches as text", async () => {
      const { bridge } = setup({ settings: { ...setup().deps.settings, saveProvider: async () => { throw new SettingsError("Введите название"); } } });
      expect(await bridge.call("saveProvider", [{}])).toEqual({ ok: false, error: "Введите название" });
    });
  });

  describe("templates", () => {
    it.each([
      ["templateEditor", "open", [{ mode: "new" }]],
      ["createTemplate", "create", [{ title: "x" }]],
      ["saveTemplate", "save", ["a", { title: "x" }]],
      ["removeTemplate", "remove", ["a", "delete"]],
    ] as const)("%s делегирует в templates.%s", async (action, method, args) => {
      const { deps, bridge } = setup();
      await bridge.call(action, [...args]);
      expect(deps.templates[method]).toHaveBeenCalledWith(...args);
    });

    it("service exception — ok:false with text", async () => {
      const { bridge } = setup({ templates: { open: vi.fn(), create: vi.fn(), save: vi.fn(), remove: () => { throw new Error("Шаблон «a» не найден."); } } });
      expect(await bridge.call("removeTemplate", ["a", "delete"])).toEqual({ ok: false, error: "Шаблон «a» не найден." });
    });
  });

  describe("lineups", () => {
    it("lineups returns the deps value", async () => {
      const { bridge } = setup();
      expect(await bridge.call("lineups", [])).toEqual({ ok: true, value: { lineups: [], error: null } });
    });

    it("saveLineup passes the input as is; a refusal is a value", async () => {
      const input = { name: "A", participants: [] };
      const { deps, bridge } = setup();
      expect(await bridge.call("saveLineup", [input])).toEqual({ ok: true, value: { ok: true, id: "l1", name: "A" } });
      expect(deps.saveLineup).toHaveBeenCalledWith(input);
      const denied = setup({ saveLineup: async () => ({ ok: false, error: "занято" }) });
      expect(await denied.bridge.call("saveLineup", [input])).toEqual({ ok: true, value: { ok: false, error: "занято" } });
    });
  });

  describe("materials", () => {
    const tmp = mkdtempSync(join(tmpdir(), "council-bridge-mat-"));
    const root = realpathSync(tmp);
    const a = join(root, "a.txt");
    const b = join(root, "b.txt");
    writeFileSync(a, "альфа");
    writeFileSync(b, "бета бета");
    writeFileSync(join(root, ".env"), "SECRET=КЛЮЧ-123");
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    const logged = (deps: BridgeDeps) => JSON.stringify([(deps.logger.info as ReturnType<typeof vi.fn>).mock.calls, (deps.logger.error as ReturnType<typeof vi.fn>).mock.calls]);

    it("materials, attachMaterials, removeMaterial, clearMaterials work through the draft", async () => {
      const { bridge } = setup();
      expect(await bridge.call("materials", [])).toMatchObject({ ok: true, value: { items: [], error: null } });
      const att = await bridge.call("attachMaterials", [[a, b]]);
      expect(att).toMatchObject({ ok: true, value: { items: [{ id: "m1", name: "a.txt" }, { id: "m2", name: "b.txt" }] } });
      expect(await bridge.call("removeMaterial", ["m1"])).toMatchObject({ ok: true, value: { items: [{ id: "m1", name: "b.txt" }] } });
      expect(await bridge.call("clearMaterials", [])).toMatchObject({ ok: true, value: { items: [], chars: 0 } });
    });

    it("Excluded by rules and return in session setup: Reset of a return — \"Back to templates\" (clearMaterials) and the same folder again", async () => {
      const proj = join(root, "proj");
      mkdirSync(join(proj, "src"), { recursive: true });
      mkdirSync(join(proj, "out"), { recursive: true });
      writeFileSync(join(proj, ".gitignore"), "out/\n");
      writeFileSync(join(proj, "src", "a.txt"), "исходник");
      writeFileSync(join(proj, "out", "main.js"), "собранный");
      const { bridge } = setup();
      const names = (r: unknown) => (r as { value: { items: { name: string }[] } }).value.items.map((i) => i.name);
      const first = await bridge.call("attachMaterials", [[proj]]);
      expect(first).toMatchObject({ ok: true, value: { ignored: [{ id: "x1", name: "proj/out/", returned: false }] } });
      const back = await bridge.call("returnIgnored", ["x1"]);
      expect(back).toMatchObject({ ok: true, value: { ignored: [{ name: "proj/out/", returned: true }] } });
      expect(names(back)).toContain("proj/out/main.js");
      await bridge.call("clearMaterials", []);
      const again = await bridge.call("attachMaterials", [[proj]]);
      expect(again).toMatchObject({ ok: true, value: { ignored: [{ id: "x1", name: "proj/out/", returned: false }] } });
      expect(names(again).filter((n) => n.startsWith("proj/out/"))).toEqual([]);
    });

    it("previewMaterials: a non-boolean argument is an error, a boolean is passed, PreviewError is a reply with a message", async () => {
      const { bridge, deps } = setup();
      for (const bad of [[], ["да"], [1], [null]]) expect(await bridge.call("previewMaterials", bad)).toMatchObject({ ok: false });
      expect(deps.previewMaterials).not.toHaveBeenCalled();
      expect(await bridge.call("previewMaterials", [true])).toEqual({ ok: true, value: { handle: "h" } });
      expect(deps.previewMaterials).toHaveBeenCalledWith(true);
      const failing = setup({ previewMaterials: () => { throw new PreviewError("нечего показывать"); } });
      expect(await failing.bridge.call("previewMaterials", [false])).toEqual({ ok: false, error: "нечего показывать" });
    });

    it("pickMaterials: the window is called with the kind, the chosen paths are added", async () => {
      const pick = vi.fn(async () => [a, b]);
      const { bridge } = setup({ pickMaterials: pick });
      const r = await bridge.call("pickMaterials", ["files"]);
      expect(pick).toHaveBeenCalledWith("files");
      expect(r).toMatchObject({ ok: true, value: { items: [{ name: "a.txt" }, { name: "b.txt" }], error: null } });
    });

    it.each([[null], [[]]])("pickMaterials: отмена %j не меняет вид и не даёт ошибки", async (picked) => {
      const { bridge } = setup({ pickMaterials: async () => picked });
      await bridge.call("attachMaterials", [[a]]);
      const r = await bridge.call("pickMaterials", ["folder"]);
      expect(r).toMatchObject({ ok: true, value: { items: [{ name: "a.txt" }], error: null } });
    });

    it.each([
      ["pickMaterials", ["dir"]],
      ["pickMaterials", []],
      ["attachMaterials", ["/x"]],
      ["attachMaterials", [[1]]],
      ["removeMaterial", [5]],
    ] as const)("%s с недопустимым входом %j: ok:false, пути в журнал не попадают", async (action, args) => {
      const pick = vi.fn(async () => null);
      const { deps, bridge } = setup({ pickMaterials: pick });
      expect(await bridge.call(action, [...args])).toMatchObject({ ok: false });
      expect(pick).not.toHaveBeenCalled();
      expect(logged(deps)).not.toContain("/x");
    });

    it("collection refusal — the error field, not an exception; paths and content go neither to the reply nor to the log", async () => {
      const { deps, bridge } = setup();
      await bridge.call("attachMaterials", [[a]]);
      const r = await bridge.call("attachMaterials", [[join(root, ".env")]]);
      expect(r).toMatchObject({ ok: true, value: { items: [{ name: "a.txt" }] } });
      const out = JSON.stringify(r);
      expect(out).toContain(".env");
      expect(out).not.toContain(root);
      expect(out).not.toContain("КЛЮЧ-123");
      expect(out).not.toContain("альфа");
      expect(deps.logger.error).not.toHaveBeenCalled();
      expect(logged(deps)).not.toContain(root);
    });

    it("replies of successful actions contain no absolute paths or texts", async () => {
      const dir = join(root, "folder");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "c.txt"), "гамма");
      const { deps, bridge } = setup();
      const out = JSON.stringify(await bridge.call("attachMaterials", [[a, dir]]));
      expect(out).toContain("folder/c.txt");
      for (const bad of [root, "альфа", "гамма", "sha256"]) expect(out).not.toContain(bad);
      expect(logged(deps)).not.toContain(root);
    });

    it("addUrl returns a view without text and without query", async () => {
      const TEXT = "ТЕКСТ-ССЫЛКИ-СЕКРЕТНЫЙ";
      const transport: UrlTransport = {
        async resolve() { return [{ address: "93.184.215.14", family: 4 }]; },
        async request(): Promise<UrlResponse> {
          return { status: 200, headers: { "content-type": "text/plain" }, body: (async function* () { yield new TextEncoder().encode(TEXT); })(), destroy() {} };
        },
      };
      const materials = createMaterialsDraft({ limits: () => ({ materialsChars: 1000, materialsIgnore: [] }), transport });
      const { bridge } = setup({ materials });
      const r = await bridge.call("addUrl", ["https://example.org/doc?token=SECRET#x"]);
      expect(r).toMatchObject({ ok: true, value: { error: null, items: [{ source: { label: "example.org/doc" } }] } });
      const out = JSON.stringify(r);
      for (const bad of [TEXT, "SECRET", "token", "sha256"]) expect(out).not.toContain(bad);
      expect(await bridge.call("addUrl", [5])).toMatchObject({ ok: false });
    });
  });
});

describe("bridge: prepareRerun", () => {
  it("success: the dependency receives the identifier and the boolean", async () => {
    const { deps, bridge } = setup();
    expect(await bridge.call("prepareRerun", ["a", true])).toEqual({ ok: true, value: { sessionId: "a" } });
    expect(deps.prepareRerun).toHaveBeenCalledWith("a", true);
  });

  it("an invalid identifier and a non-boolean withDecision do not reach the dependency", async () => {
    const { deps, bridge } = setup();
    expect((await bridge.call("prepareRerun", ["../x", false])).ok).toBe(false);
    expect(await bridge.call("prepareRerun", ["a", "да"])).toEqual({ ok: false, error: "Признак «с решением» должен быть булевым значением" });
    expect((await bridge.call("prepareRerun", ["a"])).ok).toBe(false);
    expect(deps.prepareRerun).not.toHaveBeenCalled();
  });

  it("RerunError becomes an action error with the same message", async () => {
    const { bridge } = setup({ prepareRerun: () => { throw new RerunError("Сессия ещё идёт."); } });
    expect(await bridge.call("prepareRerun", ["a", false])).toEqual({ ok: false, error: "Сессия ещё идёт." });
  });

  const map = [{ participantId: "p2", providerId: "scripted", model: "cat.json" }];

  it("the replacement map passes into deps as is", async () => {
    const { deps, bridge } = setup();
    await bridge.call("resumeOptions", ["s1", map]);
    await bridge.call("resumeSession", ["s1", 3, null, map]);
    expect(deps.resumeOptions).toHaveBeenCalledWith("s1", map, undefined);
    expect(deps.resumeSession).toHaveBeenCalledWith("s1", 3, null, map, undefined);
  });

  it.each([["не массив", {}], ["не объект", [5]], ["participantId не pN", [{ participantId: "2", providerId: "a", model: "b" }]], ["пустой model", [{ participantId: "p2", providerId: "a", model: "" }]], ["providerId не строка", [{ participantId: "p2", providerId: 1, model: "b" }]]])("замены (%s) отклоняются на мосту", async (_n, bad) => {
    const { deps, bridge } = setup();
    expect(await bridge.call("resumeOptions", ["s1", bad])).toMatchObject({ ok: false, error: expect.stringMatching(/Замен/) });
    expect(await bridge.call("resumeSession", ["s1", 3, undefined, bad])).toMatchObject({ ok: false, error: expect.stringMatching(/Замен/) });
    expect(deps.resumeOptions).not.toHaveBeenCalled();
    expect(deps.resumeSession).not.toHaveBeenCalled();
  });

  it("engine refusal in resumeOptions arrives as a message", async () => {
    const reject = vi.fn(async () => { throw new ResumeRejectedError("replacement", "Нельзя заменить p1."); });
    expect(await setup({ resumeOptions: reject }).bridge.call("resumeOptions", ["s1", map])).toEqual({ ok: false, error: "Нельзя заменить p1." });
  });
});

describe("bridge: language and refusal texts", () => {
  const prev = getProcessLanguage();
  afterEach(() => setProcessLanguage(prev));

  // [action, arguments, Russian substring, English substring]
  const cases: [string, unknown[], string, string][] = [
    ["stopSession", ["../x"], "Недопустимый идентификатор сессии", "Invalid session identifier"],
    ["sendOwnerMessage", ["s1", "  "], "Реплика должна быть непустой", "The message must not be empty"],
    ["sendOwnerMessage", ["s1", "t", 5], "Идентификатор вопроса", "The question identifier"],
    ["continueWait", ["s1", "x"], "Идентификатор ожидания", "The wait identifier"],
    ["copyText", [5], "Текст для буфера обмена", "The text for the clipboard"],
    ["setPinned", ["s1", "да"], "Признак закрепления", "The pin flag"],
    ["setPinned", ["missing", true], "не найдена", "not found"],
    ["pickMaterials", ["x"], "Недопустимый вид выбора", "Invalid materials selection kind"],
    ["attachMaterials", [[1]], "Пути материалов", "Material paths"],
    ["removeMaterial", [1], "Идентификатор материала", "The material identifier"],
    ["previewMaterials", ["да"], "Признак обновления", "The refresh flag"],
    ["prepareRerun", ["s1", "да"], "Признак «с решением»", "The “with decision” flag"],
    ["resumeSession", ["s1", 0], "Число кругов должно быть целым от 1 до 20.", "The number of rounds must be an integer from 1 to 20."],
    ["resumeSession", ["s1", 3, 0], "Новый потолок токенов", "The new token cap"],
    ["resumeSession", ["s1", 3, undefined, "x"], "Замены должны быть массивом.", "Replacements must be an array."],
    ["resumeOptions", ["s1", [{ participantId: "z" }]], "Замена 1: participantId", "Replacement 1: participantId"],
    ["resumeOptions", ["s1", [{ participantId: "p1", providerId: "", model: "m" }]], "Замена 1 (p1): нужны непустые", "Replacement 1 (p1): providerId and model must be non-empty."],
    ["acceptVersion", ["s1", 0], "Номер версии", "The version number"],
    ["acceptVersion", ["s1", 1, 5], "Заметка должна быть строкой", "The note must be a string"],
    ["sessionDrafts", ["missing"], "Сессия missing не найдена", "Session missing not found"],
    ["usageSummary", ["x", "y"], "Период задан неверно", "The period is invalid"],
    ["usageSummary", ["2026-10-09", "2026-10-08"], "Начало периода позже конца.", "The period start is later than its end."],
    ["openSession", ["missing"], "Сессия missing не найдена", "Session missing not found"],
    ["nope", [], "Неизвестное действие: nope", "Unknown action: nope"],
  ];

  it.each(cases)("%s %j: русский и английский текст", async (action, args, ru, en) => {
    const { bridge } = setup();
    setProcessLanguage("ru");
    const rr = await bridge.call(action, args);
    expect(rr).toMatchObject({ ok: false, error: expect.stringContaining(ru) });
    setProcessLanguage("en");
    const re = await bridge.call(action, args);
    expect(re).toMatchObject({ ok: false, error: expect.stringContaining(en) });
    expect((re as { error: string }).error).not.toMatch(/[А-Яа-яЁё]/);
  });

  it("core refusals (ActionError from e.message) pass through as is", async () => {
    const { bridge } = setup({ stopSession: vi.fn(() => { throw new StopRejectedError("finished", "из ядра"); }) });
    expect(await bridge.call("stopSession", ["s1"])).toEqual({ ok: false, error: "из ядра" });
  });

  it("language and setLanguage go through the dependency", async () => {
    const { deps, bridge } = setup();
    expect(await bridge.call("language", [])).toEqual({ ok: true, value: { language: "ru", source: "default", locked: false, damaged: false } });
    expect(await bridge.call("setLanguage", ["en"])).toEqual({ ok: true, value: { language: "en", source: "file", locked: false, damaged: false } });
    expect(deps.language.set).toHaveBeenCalledWith("en");
  });

  it("a language change refusal arrives as a bridge error with the refusal text", async () => {
    const { bridge } = setup({ language: { view: vi.fn(), invalidNotice: vi.fn(() => null), set: vi.fn(() => { throw new LanguageRejectedError("заперто"); }) } as never });
    expect(await bridge.call("setLanguage", ["en"])).toEqual({ ok: false, error: "заперто" });
  });

  it("appearance and setAppearance go through the dependency", async () => {
    const { deps, bridge } = setup();
    expect(await bridge.call("appearance", [])).toEqual({ ok: true, value: { mode: "dark", lightTheme: "tuman", theme: "osen" } });
    expect(await bridge.call("setAppearance", [{ mode: "light", lightTheme: "len" }])).toMatchObject({ ok: true, value: { theme: "len" } });
    expect(deps.appearance.set).toHaveBeenCalledWith({ mode: "light", lightTheme: "len" });
  });

  it("an unknown theme is refused with the shell text and appearance.json is not created", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osen-appearance-"));
    try {
      const sent: unknown[] = [];
      const appearance = createAppearanceState({ dataDir: dir, systemDark: () => false, send: (e) => sent.push(e), logger: { info() {}, error() {} } as never });
      const { bridge } = setup({ appearance });
      expect(await bridge.call("setAppearance", [{ lightTheme: "sakura" }])).toEqual({ ok: false, error: "Неизвестная настройка темы." });
      expect(existsSync(join(dir, "appearance.json"))).toBe(false);
      expect(sent).toEqual([]);
      expect(await bridge.call("setAppearance", [{ lightTheme: "len" }])).toMatchObject({ ok: true });
      expect(existsSync(join(dir, "appearance.json"))).toBe(true);
      expect(sent).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("notices returns the dependency list unchanged (the language notice is added by main)", async () => {
    const { bridge } = setup();
    expect(await bridge.call("notices", [])).toEqual({ ok: true, value: ["n"] });
  });

});

describe("bridge: startSession", () => {
  it("success: a value with the id", async () => {
    const { bridge } = setup();
    expect(await bridge.call("startSession", [{}])).toEqual({ ok: true, value: { id: "s1" } });
  });

  it("LaunchError with a code: a value with the code and text, a log entry", async () => {
    const { deps, bridge } = setup({ startSession: vi.fn(async () => { throw new LaunchError("Refresh it", "preview_retry"); }) });
    expect(await bridge.call("startSession", [{}])).toEqual({ ok: true, value: { id: null, code: "preview_retry", error: "Refresh it" } });
    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining("Refresh it"));
  });

  it("LaunchError without a code: an ordinary refusal", async () => {
    const { bridge } = setup({ startSession: vi.fn(async () => { throw new LaunchError("Nope"); }) });
    expect(await bridge.call("startSession", [{}])).toEqual({ ok: false, error: "Nope" });
  });
});

describe("bridge: connections", () => {
  it("routes the actions and passes only the client id", async () => {
    const { deps, bridge } = setup();
    expect(await bridge.call("connections", [])).toEqual({ ok: true, value: "view" });
    expect(await bridge.call("connectClient", ["codex", { command: "/evil" }, "/path"])).toEqual({ ok: true, value: "connect" });
    await bridge.call("updateClient", ["codex", "x"]);
    await bridge.call("disconnectClient", ["codex", "x"]);
    await bridge.call("checkClient", ["codex", "x"]);
    expect(await bridge.call("installCommand", ["/evil"])).toEqual({ ok: true, value: "installCommand" });
    expect(await bridge.call("removeCommand", [])).toEqual({ ok: true, value: "removeCommand" });
    for (const f of ["connect", "update", "disconnect", "check"] as const) expect(deps.connections[f]).toHaveBeenCalledWith("codex");
    expect(deps.connections.installCommand).toHaveBeenCalledWith();
  });

  it("copyZprofileLine copies main's own line, ignoring window text", async () => {
    const { deps, bridge } = setup();
    expect(await bridge.call("copyZprofileLine", ["rm -rf ~"])).toEqual({ ok: true, value: null });
    expect(deps.copyText).toHaveBeenCalledWith("LINE");
  });

  it("an unknown client becomes { ok: false } and the bridge adds no log line", async () => {
    const connect = vi.fn(async () => { throw new UnknownClientError("Неизвестный клиент"); });
    const { deps, bridge } = setup({ connections: { ...setup().deps.connections, connect } });
    expect(await bridge.call("connectClient", ["nope"])).toEqual({ ok: false, error: "Неизвестный клиент" });
    expect(deps.logger.error).not.toHaveBeenCalled();
  });
});

describe("Requirement: Действия моста для перехода CLI", () => {
  const DAY = 86_400_000;
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  let ms = T0;

  async function real() {
    const dataDir = mkdtempSync(join(tmpdir(), "bridge-cli-"));
    ms = T0;
    record(dataDir, "claude", "7.0.0", "real");
    record(dataDir, "claude", "7.1.0", "real");
    await installVersions(dataDir, "claude", [{ version: "7.0.0" }, { version: "7.1.0" }], () => new Date(T0));
    writeRegistry(dataDir, initialRegistry(["claude"]));
    const logger = { info: vi.fn(), error: vi.fn() };
    const transition = createCliTransition({
      dataDir, logger, now: () => new Date(ms), running: () => false, onChecked: () => {},
      candidateDeps: () => ({ releases: { list: async () => ["7.0.0", "7.1.0"] }, source: { fetch: async () => { throw new Error("never"); } } }),
    });
    const inspect = (async (p: { id: string }) => ({ status: { id: p.id, kind: "cli", label: p.id, available: true, models: [], modelsConfirmed: false, version: "7.0.0", source: "pin", verified: { level: "real", checkedAt: "2026-10-07" } } })) as never;
    const settings = createSettings({ dataDir, env: {}, reloadEnv: () => {}, logger, inspect, transition, now: () => new Date(ms) });
    const { bridge, deps } = setup({ settings, logger });
    return { dataDir, bridge, deps, transition, settings, logger };
  }

  it("the three actions are declared (the preload builds its API from this list)", () => {
    for (const a of ["setTransitionPeriod", "switchCli", "rollbackCli"]) expect(BRIDGE_ACTIONS).toContain(a);
    expect(readFileSync(new URL("../preload/index.ts", import.meta.url), "utf8")).toContain("BRIDGE_ACTIONS.map");
  });

  it("an undeclared name for a transition action is refused and logged", async () => {
    const { bridge, deps } = setup();
    const r = await bridge.call("useCli", ["claude", "7.1.0"]);
    expect(r.ok).toBe(false);
    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining("useCli"));
    expect(deps.settings.switchCli).not.toHaveBeenCalled();
  });

  it("malformed input is refused with a reason and pins stay", async () => {
    const { bridge, dataDir } = await real();
    try {
      const before = pinsBytes(dataDir);
      for (const [action, args] of [["switchCli", [5, "7.1.0"]], ["switchCli", ["claude", "x"]], ["switchCli", ["claude", 7]], ["rollbackCli", [{}]], ["setTransitionPeriod", ["30"]], ["setTransitionPeriod", [0]], ["setTransitionPeriod", [7.5]]] as const) {
        const r = await bridge.call(action, [...args]);
        expect(r, `${action} ${JSON.stringify(args)}`).toMatchObject({ ok: false });
        expect((r as { error: string }).error).not.toBe("");
      }
      expect(pinsBytes(dataDir)).toBe(before);
      expect(existsSync(join(dataDir, "cli-reminder.json"))).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("settings carries the transition data; the explicit actions work through the bridge", async () => {
    const { bridge, dataDir } = await real();
    try {
      ms = T0 + 40 * DAY;
      const view = (await bridge.call("settings", [])) as { ok: true; value: { transition: { periodDays: number }; providers: { cli: { due: unknown; target: unknown } }[] } };
      expect(view.value.transition.periodDays).toBe(30);
      expect(view.value.providers[0]!.cli).toMatchObject({ due: { to: "7.1.0" }, target: { version: "7.1.0" } });
      const saved = (await bridge.call("setTransitionPeriod", [14])) as typeof view;
      expect(saved.value.transition.periodDays).toBe(14);
      expect(await bridge.call("switchCli", ["claude", "7.1.0"])).toMatchObject({ ok: true });
      expect(JSON.parse(pinsBytes(dataDir)).agents.claude).toMatchObject({ active: "7.1.0", previous: "7.0.0" });
      expect(await bridge.call("rollbackCli", ["claude"])).toMatchObject({ ok: true });
      expect(JSON.parse(pinsBytes(dataDir)).agents.claude).toMatchObject({ active: "7.0.0" });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("no automatic switch: with an expired term and an installed real version, time passing never changes pins.json", async () => {
    const { bridge, dataDir, transition } = await real();
    try {
      const before = pinsBytes(dataDir);
      for (let day = 1; day <= 120; day++) {
        ms = T0 + day * DAY;
        await transition.maybeCheck();
        await bridge.call("settings", []);
        await bridge.call("recheckProviders", []);
      }
      expect(pinsBytes(dataDir)).toBe(before);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

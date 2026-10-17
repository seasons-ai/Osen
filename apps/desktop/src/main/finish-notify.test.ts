import { afterEach, describe, expect, it, vi } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import { TOPIC_LIMIT, createFinishNotifier, createFinishObserver, finishText, finishTitle } from "./finish-notify.ts";
import type { FinalStatus, FinishNotifierDeps } from "./finish-notify.ts";
import type { HistoryItem } from "../shared/bridge.ts";

const item = (id: string, status: HistoryItem["status"], over: Partial<HistoryItem> = {}): HistoryItem => ({
  id, topic: `Тема ${id}`, createdAt: "2026-01-01T00:00:00.000Z", origin: "cli", status, templateName: null,
  participants: [], round: 2, maxRounds: 4, turns: 4, pinned: false, tokenCapStop: false, tokensIncomplete: false, partial: null, ...over,
});

const FINAL: FinalStatus[] = ["consensus", "no_consensus", "stopped", "failed", "interrupted"];

function setup(over: Partial<FinishNotifierDeps> = {}) {
  const logger = { info: vi.fn(), error: vi.fn() };
  const mocks = {
    isSupported: vi.fn(() => true),
    show: vi.fn<FinishNotifierDeps["show"]>(),
    focused: vi.fn(() => false),
    openId: vi.fn((): string | null => null),
    activate: vi.fn(),
  };
  const notifier = createFinishNotifier({ ...mocks, logger, ...over });
  return { deps: mocks, logger, notifier };
}

describe("createFinishObserver", () => {
  it.each(FINAL)("возвращает сессию, завершившуюся статусом %s", (status) => {
    const o = createFinishObserver();
    expect(o.observe([item("a", "running")])).toEqual([]);
    const done = item("a", status);
    expect(o.observe([done])).toEqual([done]);
  });

  it("does not duplicate on repeated passes", () => {
    const o = createFinishObserver();
    o.observe([item("a", "running")]);
    const list = [item("a", "consensus")];
    expect(o.observe(list)).toHaveLength(1);
    expect(o.observe(list)).toEqual([]);
  });

  it("does not return sessions that finished before the first pass", () => {
    const o = createFinishObserver();
    const list = [item("a", "consensus"), item("b", "failed")];
    expect(o.observe(list)).toEqual([]);
    expect(o.observe(list)).toEqual([]);
  });

  it("does not return a session that appeared already finished", () => {
    const o = createFinishObserver();
    o.observe([item("a", "consensus")]);
    expect(o.observe([item("a", "consensus"), item("t", "consensus")])).toEqual([]);
  });

  it("markRunning and immediately finished: once", () => {
    const o = createFinishObserver();
    o.markRunning("a");
    const done = item("a", "consensus");
    expect(o.observe([done])).toEqual([done]);
    expect(o.observe([done])).toEqual([]);
  });

  it("a repeated running gives a second finish", () => {
    const o = createFinishObserver();
    o.observe([item("a", "running")]);
    expect(o.observe([item("a", "stopped")])).toHaveLength(1);
    o.observe([item("a", "running")]);
    expect(o.observe([item("a", "consensus")])).toHaveLength(1);
  });

  it("a vanished row returns nothing", () => {
    const o = createFinishObserver();
    o.observe([item("a", "running")]);
    expect(o.observe([])).toEqual([]);
  });
});

describe("finishText", () => {
  const RU: Record<FinalStatus, string> = {
    consensus: "Согласие достигнуто", no_consensus: "Согласия нет", stopped: "Обсуждение остановлено",
    failed: "Обсуждение сорвалось", interrupted: "Обсуждение прервано",
  };
  it.each(FINAL)("заголовок для %s", (status) => {
    expect(finishText(item("a", status)).title).toBe(RU[status]);
    expect(finishTitle(status)).toBe(RU[status]);
  });

  it("truncates a long topic to TOPIC_LIMIT with an ellipsis", () => {
    const { body } = finishText(item("a", "no_consensus", { topic: "слово ".repeat(30) }));
    const [topic] = body.split("\n");
    expect(topic!.length).toBeLessThanOrEqual(TOPIC_LIMIT);
    expect(topic!.endsWith("…")).toBe(true);
    expect(body).toContain("кругов: 2");
  });

  it("a topic of exactly TOPIC_LIMIT is not truncated", () => {
    const topic = "а".repeat(TOPIC_LIMIT);
    expect(finishText(item("a", "consensus", { topic })).body).toBe(`${topic}\nкругов: 2`);
  });

  it("collapses line breaks and spaces", () => {
    expect(finishText(item("a", "consensus", { topic: "  один\n\nдва   три " })).body).toBe("один два три\nкругов: 2");
  });
});

describe("createFinishNotifier", () => {
  it("shows the notification and writes one info line on shown", () => {
    const { deps, logger, notifier } = setup();
    notifier.observe([item("a", "running")]);
    notifier.observe([item("a", "consensus")]);
    deps.show.mock.calls[0]![1].shown();
    expect(deps.show).toHaveBeenCalledTimes(1);
    expect(deps.show.mock.calls[0]![0]).toEqual({ title: "Согласие достигнуто", body: "Тема a\nкругов: 2" });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("Notification shown: a — Согласие достигнуто");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("show returned, shown not called: no info", () => {
    const { logger, notifier } = setup();
    notifier.markRunning("a");
    notifier.observe([item("a", "consensus")]);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("shown twice: one info", () => {
    const { deps, logger, notifier } = setup();
    notifier.markRunning("a");
    notifier.observe([item("a", "consensus")]);
    const { shown } = deps.show.mock.calls[0]![1];
    shown();
    shown();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("failed after returning from show without shown: one error, no info", () => {
    const { deps, logger, notifier } = setup();
    notifier.markRunning("a");
    notifier.observe([item("a", "consensus")]);
    deps.show.mock.calls[0]![1].failed(new Error("x"));
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("shown, then failed: only info", () => {
    const { deps, logger, notifier } = setup();
    notifier.markRunning("a");
    notifier.observe([item("a", "consensus")]);
    const on = deps.show.mock.calls[0]![1];
    on.shown();
    on.failed(new Error("x"));
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("failed, then shown: only error", () => {
    const { deps, logger, notifier } = setup();
    notifier.markRunning("a");
    notifier.observe([item("a", "consensus")]);
    const on = deps.show.mock.calls[0]![1];
    on.failed(new Error("x"));
    on.shown();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("three passes after the notification: show once", () => {
    const { deps, notifier } = setup();
    notifier.markRunning("a");
    const list = [item("a", "consensus")];
    notifier.observe(list);
    notifier.observe(list);
    notifier.observe(list);
    expect(deps.show).toHaveBeenCalledTimes(1);
  });

  it("window focused and this session open: does not show, and not later either", () => {
    const { deps, logger, notifier } = setup();
    deps.focused.mockReturnValue(true);
    deps.openId.mockReturnValue("a");
    notifier.markRunning("a");
    const list = [item("a", "consensus")];
    notifier.observe(list);
    deps.focused.mockReturnValue(false);
    deps.openId.mockReturnValue(null);
    notifier.observe(list);
    notifier.observe(list);
    expect(deps.show).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([["другой", "b"], ["null", null]])("в фокусе, openId %s: показывает", (_n, openId) => {
    const { deps, notifier } = setup({ focused: vi.fn(() => true), openId: vi.fn(() => openId) });
    notifier.markRunning("a");
    notifier.observe([item("a", "failed")]);
    expect(deps.show).toHaveBeenCalledTimes(1);
  });

  it("not focused with the same openId: shows", () => {
    const { deps, notifier } = setup({ openId: vi.fn(() => "a") });
    notifier.markRunning("a");
    notifier.observe([item("a", "stopped")]);
    expect(deps.show).toHaveBeenCalledTimes(1);
  });

  it("a click calls activate with the session identifier", () => {
    const { deps, notifier } = setup();
    notifier.markRunning("a");
    notifier.observe([item("a", "consensus")]);
    deps.show.mock.calls[0]![1].click();
    expect(deps.activate).toHaveBeenCalledWith("a");
  });

  it("notifications not supported: one error, repeats add none", () => {
    const { deps, logger, notifier } = setup({ isSupported: vi.fn(() => false) });
    notifier.markRunning("a");
    const list = [item("a", "consensus")];
    notifier.observe(list);
    notifier.observe(list);
    notifier.observe(list);
    expect(deps.show).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("Notification not shown: the system does not support notifications (session a)");
  });

  it("show throws: one error, does not throw outward, the second session is shown", () => {
    const boom = new Error("boom");
    const show = vi.fn().mockImplementationOnce(() => { throw boom; });
    const { logger, notifier } = setup({ show });
    notifier.markRunning("a");
    notifier.markRunning("b");
    expect(() => notifier.observe([item("a", "consensus"), item("b", "consensus")])).not.toThrow();
    expect(show).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith("Notification not shown (session a)", boom);
  });

  it("failed twice: one error", () => {
    const { deps, logger, notifier } = setup();
    notifier.markRunning("a");
    notifier.observe([item("a", "consensus")]);
    const { failed } = deps.show.mock.calls[0]![1];
    failed(new Error("1"));
    failed(new Error("2"));
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("finish notification in English", () => {
  afterEach(() => setProcessLanguage("ru"));
  const EN: Record<FinalStatus, string> = {
    consensus: "Consensus reached", no_consensus: "No consensus", stopped: "Discussion stopped",
    failed: "Discussion failed", interrupted: "Discussion interrupted",
  };

  it.each(FINAL)("заголовок и «rounds» для %s", (status) => {
    setProcessLanguage("en");
    const { deps, notifier } = setup();
    notifier.markRunning("a");
    notifier.observe([item("a", status)]);
    expect(deps.show.mock.calls[0]![0]).toEqual({ title: EN[status], body: "Тема a\nrounds: 2" });
  });

  it("a topic with Cyrillic is shown verbatim", () => {
    setProcessLanguage("en");
    const { deps, notifier } = setup();
    notifier.markRunning("a");
    notifier.observe([item("a", "consensus", { topic: "Как назвать кота?" })]);
    expect(deps.show.mock.calls[0]![0].body).toBe("Как назвать кота?\nrounds: 2");
  });

  it("language change between notifications: the first stays as it was, the second in the new one", () => {
    setProcessLanguage("en");
    const { deps, notifier } = setup();
    notifier.markRunning("a");
    notifier.markRunning("b");
    notifier.observe([item("a", "consensus"), item("b", "running")]);
    setProcessLanguage("ru");
    notifier.observe([item("a", "consensus"), item("b", "failed")]);
    const calls = deps.show.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      { title: "Consensus reached", body: "Тема a\nrounds: 2" },
      { title: "Обсуждение сорвалось", body: "Тема b\nкругов: 2" },
    ]);
  });

  it("window focused on the open session: no notification in English either", () => {
    setProcessLanguage("en");
    const { deps, notifier } = setup({ focused: () => true, openId: () => "a" });
    notifier.markRunning("a");
    notifier.observe([item("a", "consensus")]);
    expect(deps.show).not.toHaveBeenCalled();
  });
});

describe("Finish notification for a session with a partially read journal", () => {
  afterEach(() => setProcessLanguage("ru"));
  const newer = { reason: "newer_version", lastEvent: 7 } as const;

  it("partial newer_version, status interrupted: \"a newer version is needed\", \"read up to event #7\", no \"Discussion interrupted\"", () => {
    const { deps, notifier } = setup();
    notifier.markRunning("d");
    notifier.observe([item("d", "interrupted", { partial: newer })]);
    expect(deps.show.mock.calls[0]![0]).toEqual({ title: "нужна новая версия", body: "Тема d\nпрочитано до события №7" });
  });

  it("corrupted: \"journal is corrupted\"", () => {
    expect(finishText(item("d", "interrupted", { partial: { reason: "corrupted", lastEvent: 3 } }), "ru"))
      .toEqual({ title: "журнал повреждён", body: "Тема d\nпрочитано до события №3" });
  });

  it("en: «newer version needed»", () => {
    setProcessLanguage("en");
    const { deps, notifier } = setup();
    notifier.markRunning("d");
    notifier.observe([item("d", "interrupted", { partial: newer })]);
    expect(deps.show.mock.calls[0]![0]).toEqual({ title: "newer version needed", body: "Тема d\nread up to event No. 7" });
  });

  it("without partial: \"Discussion interrupted\" as before", () => {
    expect(finishText(item("d", "interrupted"), "ru")).toEqual({ title: "Обсуждение прервано", body: "Тема d\nкругов: 2" });
  });

  const BADGE = { ru: { newer_version: "нужна новая версия", corrupted: "журнал повреждён" }, en: { newer_version: "newer version needed", corrupted: "journal corrupted" } };
  const cases = FINAL.flatMap((status) => (["newer_version", "corrupted"] as const).flatMap((reason) => (["ru", "en"] as const).map((language) => ({ status, reason, language }))));
  it.each(cases)("перебор: $status × $reason × $language — заголовок бейдж, ни одного заголовка статуса, круги не названы", ({ status, reason, language }) => {
    const { title, body } = finishText(item("d", status, { partial: { reason, lastEvent: 4 } }), language);
    expect(title).toBe(BADGE[language][reason]);
    expect(FINAL.map((s) => finishTitle(s, language))).not.toContain(title);
    expect(body).toContain(language === "ru" ? "прочитано до события №4" : "read up to event No. 4");
    expect(body).not.toMatch(/кругов|rounds/);
  });
});

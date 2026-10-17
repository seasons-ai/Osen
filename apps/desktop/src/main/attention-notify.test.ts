import { afterEach, describe, expect, it, vi } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import { attentionEvent, attentionText, createAttentionNotifier } from "./attention-notify.ts";
import type { AttentionSnapshot } from "./attention-notify.ts";
import type { FinishNotifierDeps } from "./finish-notify.ts";

type Wait = NonNullable<AttentionSnapshot["wait"]>;
const snap = (id: string, over: Partial<AttentionSnapshot> = {}): AttentionSnapshot => ({
  id, status: "running", ownerQuestionIds: [], wait: null, ...over,
});
const wait = (waitId: string, reasons: Wait["reasons"], questionIds: string[] = []): Wait => ({ waitId, reasons, questionIds });

function setup(over: Partial<FinishNotifierDeps> = {}) {
  const logger = { info: vi.fn(), error: vi.fn() };
  const mocks = {
    isSupported: vi.fn(() => true),
    show: vi.fn<FinishNotifierDeps["show"]>(),
    focused: vi.fn(() => false),
    openId: vi.fn((): string | null => null),
    activate: vi.fn(),
  };
  const notifier = createAttentionNotifier({ ...mocks, logger, ...over });
  return { deps: mocks, logger, notifier };
}
const titles = (show: ReturnType<typeof setup>["deps"]["show"]) => show.mock.calls.map((c) => c[0].title);

describe("createAttentionNotifier", () => {
  it("1. question without a wait: one notification, a repeat adds none", () => {
    const { deps, notifier } = setup();
    notifier.observe([snap("a")]);
    notifier.observe([snap("a", { ownerQuestionIds: ["q1"] })]);
    expect(deps.show).toHaveBeenCalledTimes(1);
    expect(deps.show.mock.calls[0]![0]).toEqual({ title: "Вопрос владельцу", body: "Откройте обсуждение в приложении." });
    expect(attentionText("question")).toEqual(deps.show.mock.calls[0]![0]);
    notifier.observe([snap("a", { ownerQuestionIds: ["q1"] })]);
    expect(deps.show).toHaveBeenCalledTimes(1);
  });

  it("2. question and an owner_question wait: one notification", () => {
    const { deps, notifier } = setup();
    notifier.observe([snap("a")]);
    notifier.observe([snap("a", { ownerQuestionIds: ["q1"], wait: wait("w1", ["owner_question"], ["q1"]) })]);
    expect(titles(deps.show)).toEqual(["Вопрос владельцу"]);
  });

  it("2b. question in one call, wait in the next: one notification", () => {
    const { deps, notifier } = setup();
    notifier.observe([snap("a")]);
    notifier.observe([snap("a", { ownerQuestionIds: ["q1"] })]);
    notifier.observe([snap("a", { ownerQuestionIds: ["q1"], wait: wait("w1", ["owner_question"], ["q1"]) })]);
    expect(deps.show).toHaveBeenCalledTimes(1);
  });

  it("3. round pause: each new wait is shown once", () => {
    const { deps, notifier } = setup();
    notifier.observe([snap("a")]);
    notifier.observe([snap("a", { wait: wait("w1", ["round_boundary"]) })]);
    expect(titles(deps.show)).toEqual(["Обсуждение ждёт владельца"]);
    notifier.observe([snap("a")]);
    notifier.observe([snap("a", { wait: wait("w2", ["round_boundary"]) })]);
    expect(deps.show).toHaveBeenCalledTimes(2);
    notifier.observe([snap("a", { wait: wait("w2", ["round_boundary"]) })]);
    expect(deps.show).toHaveBeenCalledTimes(2);
  });

  it("4. question and round pause together: one notification with the pause kind", () => {
    const { deps, notifier } = setup();
    notifier.observe([snap("a")]);
    notifier.observe([snap("a", { ownerQuestionIds: ["q1"], wait: wait("w1", ["round_boundary", "owner_question"], ["q1"]) })]);
    expect(titles(deps.show)).toEqual(["Обсуждение ждёт владельца"]);
  });

  it("5. app start: historical questions and waits are not replayed", () => {
    const { deps, notifier } = setup();
    const base = snap("a", { ownerQuestionIds: ["q1"], wait: wait("w1", ["owner_question"], ["q1"]) });
    notifier.observe([base]);
    notifier.observe([base]);
    expect(deps.show).not.toHaveBeenCalled();
    notifier.observe([{ ...base, ownerQuestionIds: ["q1", "q2"] }]);
    expect(deps.show).toHaveBeenCalledTimes(1);
  });

  it("6. session that appeared after the first call: its question is new", () => {
    const { deps, notifier } = setup();
    notifier.observe([snap("a")]);
    notifier.observe([snap("a"), snap("b", { ownerQuestionIds: ["q1"] })]);
    expect(deps.show).toHaveBeenCalledTimes(1);
  });

  it("7. not running: bookkeeping only, a later running with the same data stays silent", () => {
    const { deps, notifier } = setup();
    notifier.observe([snap("a")]);
    notifier.observe([snap("a", { status: "interrupted", ownerQuestionIds: ["q1"] })]);
    notifier.observe([snap("a", { ownerQuestionIds: ["q1"] })]);
    expect(deps.show).not.toHaveBeenCalled();
  });

  it("8. suppression while focused on this session, does not appear later; another session is shown", () => {
    const { deps, notifier } = setup();
    notifier.observe([snap("a")]);
    deps.focused.mockReturnValue(true);
    deps.openId.mockReturnValue("a");
    const q = snap("a", { ownerQuestionIds: ["q1"] });
    notifier.observe([q]);
    deps.focused.mockReturnValue(false);
    notifier.observe([q]);
    expect(deps.show).not.toHaveBeenCalled();
    deps.focused.mockReturnValue(true);
    deps.openId.mockReturnValue("other");
    notifier.observe([q, snap("b", { ownerQuestionIds: ["q1"] })]);
    expect(deps.show).toHaveBeenCalledTimes(1);
  });

  it("9. changed reasons on the same waitId do not trigger", () => {
    const { deps, notifier } = setup();
    notifier.observe([snap("a")]);
    notifier.observe([snap("a", { wait: wait("w1", ["round_boundary"]) })]);
    notifier.observe([snap("a", { ownerQuestionIds: ["q1"] })]);
    expect(deps.show).toHaveBeenCalledTimes(2);
    notifier.observe([snap("a", { ownerQuestionIds: ["q1"], wait: wait("w1", ["round_boundary", "owner_question"], ["q1"]) })]);
    expect(deps.show).toHaveBeenCalledTimes(2);
  });

  describe("10. failures", () => {
    it("show throws: one error, a repeat does not retry", () => {
      const boom = new Error("boom");
      const { deps, logger, notifier } = setup({ show: vi.fn(() => { throw boom; }) });
      notifier.observe([snap("a")]);
      const q = snap("a", { ownerQuestionIds: ["q1"] });
      expect(() => notifier.observe([q])).not.toThrow();
      notifier.observe([q]);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith("Notification not shown (session a)", boom);
      expect(deps.show).not.toHaveBeenCalled();
    });

    it("failed: one error line", () => {
      const { deps, logger, notifier } = setup();
      notifier.observe([snap("a")]);
      notifier.observe([snap("a", { ownerQuestionIds: ["q1"] })]);
      deps.show.mock.calls[0]![1].failed(new Error("x"));
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it("not supported: one error, show not called", () => {
      const { deps, logger, notifier } = setup({ isSupported: vi.fn(() => false) });
      notifier.observe([snap("a")]);
      notifier.observe([snap("a", { ownerQuestionIds: ["q1"] })]);
      expect(deps.show).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it("shown, then failed: one log line", () => {
      const { deps, logger, notifier } = setup();
      notifier.observe([snap("a")]);
      notifier.observe([snap("a", { ownerQuestionIds: ["q1"] })]);
      const on = deps.show.mock.calls[0]![1];
      on.shown();
      on.failed(new Error("x"));
      expect(logger.info).toHaveBeenCalledWith("Notification shown: a — Вопрос владельцу");
      expect(logger.info.mock.calls.length + logger.error.mock.calls.length).toBe(1);
    });
  });

  it("11. a click calls activate with the session identifier", () => {
    const { deps, notifier } = setup();
    notifier.observe([snap("a")]);
    notifier.observe([snap("a", { ownerQuestionIds: ["q1"] })]);
    deps.show.mock.calls[0]![1].click();
    expect(deps.activate).toHaveBeenCalledWith("a");
  });

  describe("wait holding an already notified question", () => {
    const both = (id: string) => wait(id, ["round_boundary", "owner_question"], ["q1"]);
    const q = (w: Wait | null) => snap("a", { ownerQuestionIds: ["q1"], wait: w });

    it("14. no second notification", () => {
      const { deps, notifier } = setup();
      notifier.observe([snap("a")]);
      notifier.observe([q(null)]);
      notifier.observe([q(both("w1"))]);
      expect(titles(deps.show)).toEqual(["Вопрос владельцу"]);
    });

    it("15. coverage works once: the next wait is a pause again", () => {
      const { deps, notifier } = setup();
      notifier.observe([snap("a")]);
      notifier.observe([q(null)]);
      notifier.observe([q(both("w1"))]);
      notifier.observe([q(null)]);
      notifier.observe([q(both("w2"))]);
      expect(titles(deps.show)).toEqual(["Вопрос владельцу", "Обсуждение ждёт владельца"]);
    });

    it("16. question answered before the boundary: the pause is notified", () => {
      const { deps, notifier } = setup();
      notifier.observe([snap("a")]);
      notifier.observe([q(null)]);
      notifier.observe([q(wait("w1", ["round_boundary"], []))]);
      expect(titles(deps.show)).toEqual(["Вопрос владельцу", "Обсуждение ждёт владельца"]);
    });

    it("17. a question from the baseline does not cover", () => {
      const { deps, notifier } = setup();
      notifier.observe([q(null)]);
      notifier.observe([q(both("w1"))]);
      expect(titles(deps.show)).toEqual(["Обсуждение ждёт владельца"]);
    });
  });

  it("13. failure on the first session does not block the second", () => {
    const show = vi.fn().mockImplementationOnce(() => { throw new Error("boom"); });
    const { notifier } = setup({ show });
    notifier.observe([snap("a"), snap("b")]);
    notifier.observe([snap("a", { ownerQuestionIds: ["q1"] }), snap("b", { ownerQuestionIds: ["q1"] })]);
    expect(show).toHaveBeenCalledTimes(2);
  });
});

describe("attentionEvent", () => {
  it("12. running opens the session, the rest and undefined are a result", () => {
    expect(attentionEvent("a", "running")).toEqual({ type: "open-session", id: "a" });
    for (const s of ["consensus", "interrupted", undefined] as const) expect(attentionEvent("a", s)).toEqual({ type: "open-result", id: "a" });
  });
});

describe("attention notifications in English", () => {
  afterEach(() => setProcessLanguage("ru"));
  const RU_BODY = "Откройте обсуждение в приложении.";

  it("question and pause: English title and body", () => {
    setProcessLanguage("en");
    const { deps, notifier } = setup();
    notifier.observe([snap("a"), snap("b")]);
    notifier.observe([snap("a", { ownerQuestionIds: ["q1"] }), snap("b", { wait: wait("w1", ["round_boundary"]) })]);
    expect(deps.show.mock.calls.map((c) => c[0])).toEqual([
      { title: "Question for the owner", body: "Open the discussion in the app." },
      { title: "The discussion is waiting for the owner", body: "Open the discussion in the app." },
    ]);
  });

  it("language change between notifications: the first stays as it was", () => {
    setProcessLanguage("en");
    const { deps, notifier } = setup();
    notifier.observe([snap("a")]);
    notifier.observe([snap("a", { ownerQuestionIds: ["q1"] })]);
    setProcessLanguage("ru");
    notifier.observe([snap("a", { ownerQuestionIds: ["q1", "q2"] })]);
    expect(deps.show.mock.calls.map((c) => c[0])).toEqual([
      { title: "Question for the owner", body: "Open the discussion in the app." },
      { title: "Вопрос владельцу", body: RU_BODY },
    ]);
  });

  it("window focused on the open session: no notification in English either", () => {
    setProcessLanguage("en");
    const { deps, notifier } = setup({ focused: () => true, openId: () => "a" });
    notifier.observe([snap("a")]);
    notifier.observe([snap("a", { ownerQuestionIds: ["q1"] })]);
    expect(deps.show).not.toHaveBeenCalled();
  });
});

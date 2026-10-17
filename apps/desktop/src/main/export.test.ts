import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProcessLanguage } from "@model-council/core/i18n";
import { appendEvent, createSessionJournal, draftPath, readSession, writeDraftSnapshot } from "@model-council/core";
import type { StoredSession } from "@model-council/core";
import { foldEvents } from "@model-council/core/protocol";
import type { SessionEvent } from "@model-council/core/protocol";
import { sessionMarkdown } from "./markdown.ts";
import { exportFileName, exportSession } from "./export.ts";
import { sessionDrafts } from "./drafts.ts";
import type { ExportDeps } from "./export.ts";

const stored = { id: "s1", state: { session: { topic: "Тема: а/б" } }, status: "done" } as unknown as StoredSession;
function deps(over: Partial<ExportDeps> = {}): ExportDeps {
  return { read: vi.fn(() => stored), render: vi.fn(() => "# md"), pickPath: vi.fn(async () => "/tmp/x.md"), write: vi.fn(async () => {}), ...over };
}

describe("exportFileName", () => {
  it("ordinary topic", () => expect(exportFileName("Цена продукта")).toBe("Цена продукта.md"));
  it("forbidden characters and line breaks", () => {
    expect(exportFileName('а/б\\в:г*д?е"ж<з>и|к')).toBe("а б в г д е ж з и к.md");
    expect(exportFileName("  первая\nвторая\t\x01третья  ")).toBe("первая вторая третья.md");
  });
  it("empty topic", () => expect(exportFileName(" / ")).toBe("обсуждение.md"));
  it("a long topic is cut to 60 characters", () => expect(exportFileName("я".repeat(100))).toBe("я".repeat(60) + ".md"));
});

describe("exportSession", () => {
  it("session not found", async () => {
    await expect(exportSession("s1", deps({ read: () => null }))).rejects.toThrow("Сессия s1 не найдена");
  });
  it("cancel: write is not called", async () => {
    const d = deps({ pickPath: async () => null });
    expect(await exportSession("s1", d)).toBeNull();
    expect(d.write).not.toHaveBeenCalled();
  });
  it("write error", async () => {
    const d = deps({ write: async () => { throw new Error("нет места"); } });
    await expect(exportSession("s1", d)).rejects.toThrow("Не удалось сохранить файл /tmp/x.md: нет места");
  });
  it("success: name from the topic, text from render", async () => {
    const d = deps();
    expect(await exportSession("s1", d)).toEqual({ path: "/tmp/x.md" });
    expect(d.pickPath).toHaveBeenCalledWith("Тема а б.md");
    expect(d.write).toHaveBeenCalledWith("/tmp/x.md", "# md");
  });
});

describe("export: process language at call time", () => {
  afterEach(() => { setProcessLanguage("ru"); });
  it("fallback file name by language; an ordinary topic does not change", () => {
    setProcessLanguage("en");
    expect(exportFileName("///")).toBe("discussion.md");
    expect(exportFileName("Цена продукта")).toBe("Цена продукта.md");
    setProcessLanguage("ru");
    expect(exportFileName("///")).toBe("обсуждение.md");
    expect(exportFileName("///", "en")).toBe("discussion.md");
  });
  it("refusals: English, the path and the original message are kept; the language changes without a restart", async () => {
    setProcessLanguage("en");
    await expect(exportSession("s1", deps({ read: () => null }))).rejects.toThrow("Session s1 not found");
    const w = deps({ write: async () => { throw new Error("нет места"); } });
    await expect(exportSession("s1", w)).rejects.toThrow("Could not save the file /tmp/x.md: нет места");
    setProcessLanguage("ru");
    await expect(exportSession("s1", deps({ read: () => null }))).rejects.toThrow("Сессия s1 не найдена");
    await expect(exportSession("s1", w)).rejects.toThrow("Не удалось сохранить файл /tmp/x.md: нет места");
  });
});

describe("exportSession: dialog with the owner", () => {
  it("the written file has the message and the owner-question mark", async () => {
    const ts = "2026-01-01T00:00:00Z";
    const events = [
      { type: "session_created", pid: 1, session: { id: "s1", createdAt: ts, origin: "cli", topic: "Т", templateId: null, framing: "",
        participants: [{ id: "p1", name: "Имя1", providerId: "scripted", model: "m", role: null }], limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 } } },
      { type: "turn_started", turn: 1, round: 1, participantId: "p1" },
      { type: "turn_completed", turn: 1, round: 1, participantId: "p1", stance: "amend", normalized: false, reasoning: "а", solution: "т", version: 1,
        questions: [{ id: "q1", to: "owner", text: "Бюджет?" }], answers: [], attempts: 1, usage: {}, durationMs: 5 },
      { type: "question_closed", questionId: "q1", reason: "unanswered" },
      { type: "owner_message", id: "o1", text: "Без бюджета", afterTurn: 1, requestId: "r1" },
    ].map((e, i) => ({ ...e, seq: i + 1, ts }) as unknown as SessionEvent);
    const state = foldEvents(events);
    const d = deps({ read: () => ({ id: "s1", state, status: "running" }) as unknown as StoredSession, render: (s) => sessionMarkdown(s.state, s.status) });
    await exportSession("s1", d);
    const text = (d.write as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(text).toContain("### Владелец · o1 · после хода 1");
    expect(text).toContain("(закрыт без ответа)");
  });
});

describe("exportSession: render receives the id; draft texts from snapshots (change 109)", () => {
  it("render(session, id) — the session id as the second argument", async () => {
    const d = deps();
    await exportSession("s1", d);
    expect(d.render).toHaveBeenCalledWith(stored, "s1");
  });

  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const ts = "2026-01-01T00:00:00Z";
  function seed(): string {
    const dir = mkdtempSync(join(tmpdir(), "council-export-drafts-"));
    dirs.push(dir);
    createSessionJournal(dir, "s1");
    const texts = ["ТЕКСТ-ПЕРВОГО\nвторая строка", "ТЕКСТ-ВТОРОГО"];
    const snaps = texts.map((t, i) => writeDraftSnapshot(dir, "s1", `d${i + 1}`, t));
    const events = [
      { type: "session_created", pid: 99999999, session: { id: "s1", createdAt: ts, origin: "cli", topic: "Т", templateId: null, framing: "",
        participants: [1, 2].map((i) => ({ id: `p${i}`, name: `Имя${i}`, providerId: "scripted", model: "m", role: null })),
        limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 }, drafts: { enabled: true, synthesizerId: "p1" } } },
      ...snaps.flatMap((sn, i) => [
        { type: "draft_attempt_started", draftId: `d${i + 1}`, participantId: `p${i + 1}`, attempt: 1 },
        { type: "draft_completed", draftId: `d${i + 1}`, participantId: `p${i + 1}`, attempts: 1, durationMs: 1, usage: {}, chars: sn.chars, sha256: sn.sha256, reasoning: `арг${i + 1}` },
      ]),
      { type: "drafts_finished" },
    ];
    events.forEach((e, i) => appendEvent(dir, "s1", { ...e, seq: i + 1, ts } as unknown as SessionEvent));
    return dir;
  }
  const run = async (dir: string) => {
    const write = vi.fn(async (_p: string, _t: string) => {});
    const d: ExportDeps = {
      read: (id) => readSession(dir, id), pickPath: async () => "/tmp/x.md", write,
      render: (s, i) => sessionMarkdown(s.state, s.status, "ru", s.partial, sessionDrafts(dir, i)),
    };
    await exportSession("s1", d);
    return write.mock.calls[0]![1] as string;
  };

  it("the text in the file equals the snapshot", async () => {
    const text = await run(seed());
    expect(text).toContain("**Текст черновика:**\n\nТЕКСТ-ПЕРВОГО\nвторая строка");
    expect(text).toContain("**Текст черновика:**\n\nТЕКСТ-ВТОРОГО");
  });
  it("corrupted snapshot: the \"Text unavailable\" line, export completes, the second draft is intact", async () => {
    const dir = seed();
    writeFileSync(draftPath(dir, "s1", "d1"), "подменено");
    const text = await run(dir);
    expect(text).toMatch(/Текст недоступен: .+/);
    expect(text).not.toContain("подменено");
    expect(text).toContain("ТЕКСТ-ВТОРОГО");
  });
});

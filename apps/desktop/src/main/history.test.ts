import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, createSessionJournal, eventsPath, loadTemplates } from "@model-council/core";
import { appendFileSync, readFileSync } from "node:fs";
import { readPins, setPinned } from "./pins.ts";
import type { Session, SessionEvent } from "@model-council/core";
import { historyItems, historyRead, startHistoryPolling, unreadableJournalLog } from "./history.ts";
import type { HistoryItem } from "../shared/bridge.ts";

const ts = (n = 0) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const mkSession = (id: string, o: Partial<Session> = {}): Session => ({
  id, createdAt: ts(), origin: "cli", topic: `Тема ${id}`, templateId: null, framing: "",
  participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
  limits: { maxRounds: 4, turnTimeoutSec: 60, contextChars: 1000 }, ...o,
});
const turn = (n: number, seq: number): SessionEvent[] => [
  { seq, ts: ts(), type: "turn_started", turn: n, round: 1, participantId: `p${n}` },
  {
    seq: seq + 1, ts: ts(), type: "turn_completed", turn: n, round: 1, participantId: `p${n}`, stance: "agree", normalized: false,
    reasoning: "ok", solution: null, version: 1, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1,
  },
];
const finished = (seq: number): SessionEvent => ({
  seq, ts: ts(), type: "session_finished", status: "consensus", version: 1, agreed: ["p1", "p2"], objectors: [],
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "council-hist-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(s: Session, pid: number, rest: SessionEvent[]) {
  createSessionJournal(dir, s.id);
  appendEvent(dir, s.id, { seq: 1, ts: s.createdAt, type: "session_created", session: s, pid });
  for (const e of rest) appendEvent(dir, s.id, e);
}

describe("historyItems", () => {
  it("finished session: fields, round, turns, limit", () => {
    write(mkSession("a"), 1, [...turn(1, 2), ...turn(2, 4), finished(6)]);
    expect(historyItems(dir, new Map(), new Set())).toEqual([{
      id: "a", topic: "Тема a", createdAt: ts(), origin: "cli", status: "consensus", templateName: null,
      participants: [{ id: "p1", name: "n1", model: "m", dropped: false }, { id: "p2", name: "n2", model: "m", dropped: false }],
      round: 1, maxRounds: 4, turns: 2, pinned: false, tokenCapStop: false, tokensIncomplete: true, partial: null,
    }]);
  });

  describe("token ceiling", () => {
    const stop = (seq: number, reason?: string): SessionEvent => ({ seq, ts: ts(), type: "session_finished", status: "stopped", version: null, agreed: [], objectors: [], ...(reason ? { reason } : {}) } as SessionEvent);
    const used = (seq: number): SessionEvent[] => turn(1, seq).map((e) => (e.type === "turn_completed" ? { ...e, usage: { inputTokens: 300, outputTokens: 200 } } : e));

    it("stopped by the ceiling", () => {
      write(mkSession("a", { limits: { maxRounds: 4, turnTimeoutSec: 60, contextChars: 1000, maxTotalTokens: 400 } }), 1, [...used(2), stop(4, "token_cap")]);
      const [i] = historyItems(dir, new Map(), new Set());
      expect(i).toMatchObject({ status: "stopped", tokenCapStop: true, tokensIncomplete: false });
    });

    it("stopped by the owner", () => {
      write(mkSession("a"), 1, [...used(2), stop(4)]);
      expect(historyItems(dir, new Map(), new Set())[0]).toMatchObject({ status: "stopped", tokenCapStop: false });
    });

    it("participants without tokens: incomplete accounting", () => {
      write(mkSession("a"), 1, [...turn(1, 2), finished(4)]);
      expect(historyItems(dir, new Map(), new Set())[0]).toMatchObject({ tokenCapStop: false, tokensIncomplete: true });
    });
  });

  it("running and interrupted", () => {
    write(mkSession("live", { createdAt: ts(2) }), 1, turn(1, 2));
    write(mkSession("dead", { createdAt: ts(1) }), 2 ** 22 + 12345, turn(1, 2));
    const items = historyItems(dir, new Map(), new Set());
    expect(items.map((i) => [i.id, i.status])).toEqual([["live", "running"], ["dead", "interrupted"]]);
  });

  it("a dropped participant", () => {
    write(mkSession("a"), 1, [
      { seq: 2, ts: ts(), type: "participant_dropped", participantId: "p2", reason: "сбой" } as SessionEvent,
    ]);
    expect(historyItems(dir, new Map(), new Set())[0]!.participants).toEqual([
      { id: "p1", name: "n1", model: "m", dropped: false }, { id: "p2", name: "n2", model: "m", dropped: true },
    ]);
  });

  it("template: known, unknown, null; order from newest to oldest", () => {
    write(mkSession("a", { templateId: "known", createdAt: ts(1) }), 1, []);
    write(mkSession("b", { templateId: "gone", createdAt: ts(2) }), 1, []);
    write(mkSession("c", { createdAt: ts(3) }), 1, []);
    const items = historyItems(dir, new Map([["known", "Название"]]), new Set());
    expect(items.map((i) => [i.id, i.templateName])).toEqual([["c", null], ["b", "gone"], ["a", "Название"]]);
  });

  it("the template name comes from the catalog of the current language; the journal does not change", () => {
    const root = join(dir, "builtin");
    mkdirSync(root);
    for (const [lang, title] of [["ru", "Архитектура"], ["en", "Architecture"]] as const) {
      mkdirSync(join(root, lang));
      writeFileSync(join(root, lang, "neutral.md"), "N");
      writeFileSync(join(root, lang, "arch.json"), JSON.stringify({ id: "arch", title, category: "K", description: "d", exampleTopic: "t", framing: "F" }));
    }
    write(mkSession("a", { templateId: "arch", framing: "РАМКА-ИЗ-ЖУРНАЛА" }), 1, []);
    const journal = () => readFileSync(join(dir, "sessions", "a", "events.jsonl"), "utf8");
    const before = journal();
    const titles = (language: "ru" | "en") =>
      new Map(loadTemplates({ builtinDir: root, userDir: join(dir, "user"), language }).templates.map((t) => [t.id, t.title]));
    expect(historyItems(dir, titles("ru"), new Set())[0]!.templateName).toBe("Архитектура");
    expect(historyItems(dir, titles("en"), new Set())[0]!.templateName).toBe("Architecture");
    expect(journal()).toBe(before);
  });

  it("pinned: pinned ones are marked, an unknown identifier creates no row, order unchanged", () => {
    write(mkSession("a", { createdAt: ts(1) }), 1, []);
    write(mkSession("b", { createdAt: ts(2) }), 1, []);
    const items = historyItems(dir, new Map(), new Set(["a", "ghost"]));
    expect(items.map((i) => [i.id, i.pinned])).toEqual([["b", false], ["a", true]]);
  });

  it("the session journal does not change byte for byte from reading and pinning", () => {
    write(mkSession("a"), 1, [...turn(1, 2), finished(4)]);
    const log = () => readFileSync(join(dir, "sessions", "a", "events.jsonl"));
    const before = log();
    historyItems(dir, new Map(), new Set(readPins(dir).ids));
    setPinned(dir, "a", true);
    historyItems(dir, new Map(), new Set(readPins(dir).ids));
    setPinned(dir, "a", false);
    expect(log().equals(before)).toBe(true);
  });

  it("empty data folder", () => {
    expect(historyItems(dir, new Map(), new Set())).toEqual([]);
  });
});

describe("startHistoryPolling", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const item = (id: string) => ({ id }) as HistoryItem;

  it("emit only on change, refresh and stop", () => {
    let data = [item("a")];
    const emit = vi.fn();
    const p = startHistoryPolling({ read: () => data, emit, onError: vi.fn() });
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6000);
    expect(emit).toHaveBeenCalledTimes(1);
    data = [item("a"), item("b")];
    p.refresh();
    expect(emit).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    expect(emit).toHaveBeenCalledTimes(2);
    data = [];
    p.stop();
    vi.advanceTimersByTime(10000);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("the same error is not repeated, polling continues", () => {
    let fail = true;
    const emit = vi.fn();
    const onError = vi.fn();
    const p = startHistoryPolling({ read: () => { if (fail) throw new Error("x"); return [item("a")]; }, emit, onError });
    vi.advanceTimersByTime(6000);
    expect(onError).toHaveBeenCalledTimes(1);
    fail = false;
    vi.advanceTimersByTime(2000);
    expect(emit).toHaveBeenCalledTimes(1);
    p.stop();
  });
});

describe("historyRead", () => {
  const asked = (to: string): SessionEvent[] => {
    const [started, done] = turn(1, 2);
    return [started!, { ...done!, questions: [{ id: "q1", to, text: "Текст с меткой SECRET-35" }] } as SessionEvent];
  };
  const waitStarted: SessionEvent = {
    seq: 4, ts: ts(), type: "owner_wait_started", waitId: "w1", reasons: ["owner_question"], questionIds: ["q1"], afterTurn: 1, deadline: ts(300),
  } as SessionEvent;

  it("attention snapshot: owner questions and wait, without texts", () => {
    write(mkSession("a"), 1, [...asked("owner"), waitStarted]);
    const { attention } = historyRead(dir, new Map(), new Set());
    expect(attention).toEqual([{ id: "a", status: "running", ownerQuestionIds: ["q1"], wait: { waitId: "w1", reasons: ["owner_question"], questionIds: ["q1"] } }]);
    const json = JSON.stringify(attention);
    expect(json).not.toContain("SECRET-35");
    expect(json).not.toContain("Тема a");
  });

  it("a question to a participant does not get into ownerQuestionIds", () => {
    write(mkSession("a"), 1, asked("p2"));
    expect(historyRead(dir, new Map(), new Set()).attention).toEqual([{ id: "a", status: "running", ownerQuestionIds: [], wait: null }]);
  });

  it("items matches historyItems", () => {
    write(mkSession("a"), 1, [...asked("owner"), waitStarted]);
    write(mkSession("b", { createdAt: ts(1) }), 1, [...turn(1, 2), finished(4)]);
    expect(historyRead(dir, new Map(), new Set()).items).toEqual(historyItems(dir, new Map(), new Set()));
  });
});

describe("historyItems: partial", () => {
  const raw = (id: string, line: string) => appendFileSync(eventsPath(dir, id), line);
  it("a line of unknown type: newer_version and the number of the last read event", () => {
    write(mkSession("a"), 1, turn(1, 2));
    raw("a", JSON.stringify({ seq: 4, ts: ts(), type: "future_event" }) + "\n");
    expect(historyItems(dir, new Map(), new Set())[0]!.partial).toEqual({ reason: "newer_version", lastEvent: 3 });
  });
  it("a broken line: corrupted and the number of the last read event", () => {
    write(mkSession("a"), 1, turn(1, 2));
    raw("a", '{"seq": 4, "ty\n');
    raw("a", JSON.stringify(turn(2, 4)[0]) + "\n");
    expect(historyItems(dir, new Map(), new Set())[0]!.partial).toEqual({ reason: "corrupted", lastEvent: 3 });
  });
  it("whole journal: partial = null", () => {
    write(mkSession("a"), 1, [...turn(1, 2), finished(4)]);
    expect(historyItems(dir, new Map(), new Set())[0]!.partial).toBeNull();
  });
});

describe("historyRead: unreadable journal", () => {
  it("chmod 000 and a folder instead of events.jsonl: the other rows are returned, onUnreadable receives the id", () => {
    write(mkSession("good", { createdAt: ts(1) }), 1, [...turn(1, 2), finished(4)]);
    write(mkSession("denied", { createdAt: ts(2) }), 1, []);
    mkdirSync(join(dir, "sessions", "isdir"), { recursive: true });
    mkdirSync(eventsPath(dir, "isdir"));
    chmodSync(eventsPath(dir, "denied"), 0o000);
    const seen: string[] = [];
    try {
      const r = historyRead(dir, new Map(), new Set(), (id) => seen.push(id));
      expect(r.items.map((i) => i.id)).toEqual(["good"]);
      expect(seen.sort()).toEqual(["denied", "isdir"]);
    } finally {
      chmodSync(eventsPath(dir, "denied"), 0o600);
    }
  });

  it("the only unreadable session: an empty list without an exception", () => {
    write(mkSession("only"), 1, []);
    chmodSync(eventsPath(dir, "only"), 0o000);
    const seen: string[] = [];
    try {
      expect(historyRead(dir, new Map(), new Set(), (id) => seen.push(id)).items).toEqual([]);
      expect(historyItems(dir, new Map(), new Set())).toEqual([]);
      expect(seen).toEqual(["only"]);
    } finally {
      chmodSync(eventsPath(dir, "only"), 0o600);
    }
  });
});

describe("historyRead: garbage journal", () => {
  it("onUnreadable receives the id once, it is not in items, five polls log one line", () => {
    write(mkSession("good"), 1, [...turn(1, 2), finished(4)]);
    createSessionJournal(dir, "junk");
    writeFileSync(eventsPath(dir, "junk"), "garbage\n");
    const lines: string[] = [];
    const onUnreadable = unreadableJournalLog({ info: () => {}, error: (m) => lines.push(m) });
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = historyRead(dir, new Map(), new Set(), (id, e) => { if (i === 0) seen.push(id); onUnreadable(id, e); });
      expect(r.items.map((x) => x.id)).toEqual(["good"]);
    }
    expect(seen).toEqual(["junk"]);
    expect(lines).toEqual(["Session journal junk not read"]);
  });
});

describe("unreadableJournalLog: polling \"History\" every 2 s does not multiply log lines", () => {
  it("one line per session and reason; a new reason or another session is a new line", () => {
    const lines: string[] = [];
    const log = unreadableJournalLog({ info: () => {}, error: (m) => lines.push(m) });
    const eacces = Object.assign(new Error("EACCES"), { code: "EACCES" });
    for (let i = 0; i < 5; i++) log("s1", eacces);
    expect(lines).toEqual(["Session journal s1 not read"]);
    log("s1", Object.assign(new Error("EISDIR"), { code: "EISDIR" }));
    log("s2", eacces);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("s2");
  });
});

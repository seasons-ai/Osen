import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDraftPrompt, buildMaterialsPreview, buildTurnPrompt } from "./context.ts";
import { buildCorrectionPrompt, parseDraftResponse, parseTurnResponse } from "./parse.ts";
import { serveFiles } from "./folder.ts";
import { initialState } from "./state.ts";
import type { SessionState, TurnRecord } from "./state.ts";
import { participantSystemPrompt } from "../cli-agents/args.ts";

// Reference requests of a Russian session, captured before change 63 (requirement «Requests of the Russian session are unchanged»).
// Golden files are rewritten only with GOLDEN_WRITE=1, and only deliberately: the golden file fixes the previous text.
const DIR = join(import.meta.dirname, "__golden__");

const turn = (n: number, round: number, participantId: string, over: Partial<TurnRecord> = {}): TurnRecord => ({
  turn: n, round, participantId, stance: "object", normalized: false, reasoning: `Аргументы хода ${n}: ${"довод ".repeat(n * 3)}`,
  version: 1, newVersion: false, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 0, ...over,
});

export function goldenState(contextChars = 100000): SessionState {
  return {
    ...initialState(),
    session: {
      id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "Как назвать сервис?\nНужны варианты.",
      templateId: "naming", framing: "Рамка: короткие имена.",
      participants: [
        { id: "p1", name: "Альфа", providerId: "scripted", model: "m", role: "критик" },
        { id: "p2", name: "Бета", providerId: "scripted", model: "m", role: null },
        { id: "p3", name: "Гамма", providerId: "scripted", model: "m", role: null },
        { id: "p4", name: "Дельта", providerId: "scripted", model: "m", role: null, replaces: "p3" },
      ],
      limits: { maxRounds: 4, turnTimeoutSec: 60, contextChars },
    },
    participants: [
      { id: "p1", status: "active", dropReason: null },
      { id: "p2", status: "dropped", dropReason: "сбой" },
      { id: "p3", status: "dropped", dropReason: null, replacedBy: "p4" },
      { id: "p4", status: "active", dropReason: null, replaces: "p3" },
    ],
    versions: [{ number: 2, text: "Версия два: «Совет».", authorId: "p1", turn: 3 }],
    round: 2,
    turns: [
      turn(1, 1, "p1", { stance: "amend", newVersion: true, version: 1 }),
      turn(2, 1, "p2", { stance: "object", normalized: true, questions: [{ id: "q1", to: "p1", text: "Почему так?" }] }),
      turn(3, 2, "p1", {
        stance: "amend", newVersion: true, version: 2, answers: [{ questionId: "q1", text: "Потому что коротко." }],
        filesRead: [{ name: "d/a.txt", chars: 3, shown: 3 }, { name: "d/b.txt", chars: 2, shown: 2 }],
      }),
    ],
    questions: [
      { id: "q1", from: "p2", to: "p1", text: "Почему так?", turn: 2, status: "answered", answer: null },
      { id: "q2", from: "p1", to: "p4", text: "Согласен?", turn: 3, status: "open", answer: null },
      { id: "q3", from: "p1", to: "owner", text: "Какой бюджет?", turn: 3, status: "open", answer: null },
      { id: "q4", from: "p2", to: "owner", text: "Какой срок?", turn: 2, status: "answered", answer: "до пятницы" },
      { id: "q5", from: "p2", to: "owner", text: "Мобильная версия?", turn: 2, status: "unanswered", answer: null },
    ],
    ownerMessages: [{ id: "o1", text: "Имя на латинице.", afterTurn: 2, requestId: "r1", answers: [] }],
  };
}

const materials = [{ id: "m1", name: "заметки.md", text: "Текст материала." }, { id: "m2", name: "d/a.txt", text: "abc" }];
// 600 files: the list does not fit whole, part of it collapses into a folder line.
const folder = [
  { name: "d/a.txt", text: "abc" }, { name: "d/b.txt", text: "😀" },
  ...Array.from({ length: 600 }, (_, i) => ({ name: `d/deep/sub/file-${String(i).padStart(3, "0")}.txt`, text: "x".repeat(i % 7) })),
  { name: "d/big.txt", text: "y".repeat(50000) },
];
const served = serveFiles(folder, ["d/a.txt", "d/нет.txt", "d/big.txt", "d/b.txt", "d/deep/", "d/a.txt", "d/лишний.txt"], "ru");
const drafts = [{ draftId: "d1", participantId: "p1", text: "Черновик один.", reasoning: "Обоснование один." }];
const LONG_RAW = `не JSON ${"ж".repeat(2100)}`;

function cases(): Record<string, string> {
  const s = goldenState();
  const turnPrompt = buildTurnPrompt(s, "p4", materials, { folder, served, drafts });
  const first = { ...goldenState(), versions: [], turns: [], questions: [], ownerMessages: [] };
  const errors = [
    ...(parseTurnResponse(LONG_RAW, s, "p4") as { errors: string[] }).errors,
    ...(parseTurnResponse(JSON.stringify({ stance: "amend", reasoning: " ", solution: "", answers: [], questions: [{ to: "p1", text: " " }], files: [] }), s, "p4") as { errors: string[] }).errors,
    ...(parseTurnResponse(JSON.stringify({ stance: "agree", reasoning: "r", solution: "текст", answers: [], questions: [], files: [] }), s, "p4") as { errors: string[] }).errors,
    ...(parseTurnResponse(JSON.stringify({ stance: "agree", reasoning: "r", solution: null, answers: [], questions: [], files: [] }), first, "p1") as { errors: string[] }).errors,
    ...(parseTurnResponse(JSON.stringify({
      stance: "object", reasoning: "r", solution: null, answers: [],
      questions: [{ to: "p4", text: "a" }, { to: "p9", text: "b" }, { to: "p2", text: "c" }, { to: "owner", text: "d" }], files: [],
    }), s, "p4") as { errors: string[] }).errors,
  ];
  const draftErrors = [
    ...(parseDraftResponse("без объекта", "ru") as { errors: string[] }).errors,
    ...(parseDraftResponse(JSON.stringify({ stance: "object", reasoning: "r", solution: null, answers: [{ questionId: "q1", text: "a" }], questions: [{ to: "owner", text: "q" }], files: [] }), "ru") as { errors: string[] }).errors,
  ];
  const draftPrompt = buildDraftPrompt(s.session!, "p1", materials, { folder, served });
  const preview = buildMaterialsPreview({ language: "ru", materials, workspace: folder, skipped: [], left: [] });
  return {
    "system-prompt": participantSystemPrompt("ru"),
    "turn-full": turnPrompt,
    "turn-first": buildTurnPrompt(first, "p1"),
    "turn-truncated": buildTurnPrompt(goldenState(400), "p1"),
    "draft": draftPrompt,
    "correction-turn": buildCorrectionPrompt(buildTurnPrompt(first, "p1"), LONG_RAW, errors, "ru"),
    "correction-draft": buildCorrectionPrompt(buildDraftPrompt(s.session!, "p2"), "без объекта", draftErrors, "ru"),
    "preview-initial": preview.initial!,
    "preview-manifest": preview.manifest!,
  };
}

describe("Requests of the Russian session are unchanged: reference requests", () => {
  const all = cases();
  if (process.env.GOLDEN_WRITE === "1") {
    mkdirSync(DIR, { recursive: true });
    for (const [name, text] of Object.entries(all)) writeFileSync(join(DIR, `${name}.txt`), text);
  }
  for (const [name, text] of Object.entries(all)) {
    it(name, () => {
      const file = join(DIR, `${name}.txt`);
      expect(existsSync(file)).toBe(true);
      expect(text).toBe(readFileSync(file, "utf8"));
    });
  }
});

import { describe, it, expect } from "vitest";
import { buildDraftPrompt, buildMaterialsPreview, buildTurnPrompt, draftRules, protocolRules } from "./context.ts";
import { buildCorrectionPrompt, parseTurnResponse } from "./parse.ts";
import { serveFiles } from "./folder.ts";
import { initialState } from "./state.ts";
import type { SessionState, TurnRecord } from "./state.ts";
import type { Language } from "../i18n/language.ts";

const CYR = /[А-Яа-яЁё]/;

// Session in en with English owner data: any Cyrillic in the request is untranslated engine text.
const mkState = (language: Language | undefined, over: Partial<SessionState> = {}, contextChars = 100000): SessionState => ({
  ...initialState(),
  session: {
    id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "TOPIC-TEXT", templateId: null, framing: "FRAMING-TEXT",
    participants: [
      { id: "p1", name: "Alpha", providerId: "scripted", model: "m", role: "critic" },
      { id: "p2", name: "Beta", providerId: "scripted", model: "m", role: null },
      { id: "p3", name: "Gamma", providerId: "scripted", model: "m", role: null },
      { id: "p4", name: "Delta", providerId: "scripted", model: "m", role: null, replaces: "p3" },
    ],
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars },
    ...(language ? { language } : {}),
  },
  participants: [
    { id: "p1", status: "active", dropReason: null },
    { id: "p2", status: "dropped", dropReason: "x" },
    { id: "p3", status: "dropped", dropReason: null, replacedBy: "p4" },
    { id: "p4", status: "active", dropReason: null, replaces: "p3" },
  ],
  ...over,
});
const turn = (n: number, over: Partial<TurnRecord> = {}): TurnRecord => ({
  turn: n, round: 1, participantId: "p1", stance: "object", normalized: false, reasoning: `ARG-${n} ${"word ".repeat(20)}`,
  version: 1, newVersion: false, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 0, ...over,
});
const busy = (contextChars = 100000) => mkState("en", {
  versions: [{ number: 1, text: "SOLUTION-V1", authorId: "p1", turn: 1 }], round: 2,
  turns: [
    turn(1, { stance: "amend", newVersion: true }),
    turn(2, { participantId: "p4", normalized: true, questions: [{ id: "q1", to: "p1", text: "Why?" }] }),
    turn(3, { answers: [{ questionId: "q1", text: "Because." }], filesRead: [{ name: "d/a.txt", chars: 3, shown: 3 }] }),
  ],
  questions: [
    { id: "q2", from: "p1", to: "p4", text: "Agree?", turn: 3, status: "open", answer: null },
    { id: "q3", from: "p1", to: "owner", text: "Budget?", turn: 3, status: "open", answer: null },
    { id: "q4", from: "p4", to: "owner", text: "Deadline?", turn: 2, status: "answered", answer: "Friday" },
    { id: "q5", from: "p4", to: "owner", text: "Mobile?", turn: 2, status: "unanswered", answer: null },
  ],
  ownerMessages: [{ id: "o1", text: "Latin name.", afterTurn: 2, requestId: "r1", answers: [] }],
}, contextChars);

const materials = [{ id: "m1", name: "notes.md", text: "MATERIAL-TEXT" }];
const folder = [{ name: "d/a.txt", text: "abc" }, ...Array.from({ length: 700 }, (_, i) => ({ name: `d/deep/x/f${i}.txt`, text: "y" }))];

describe("Model requests in the session language: English session", () => {
  it("English session: all sections and labels in English, owner data verbatim, no response language specified", () => {
    const served = serveFiles(folder, ["d/a.txt", "d/none.txt", "a", "b", "c", "d"], "en");
    const p = buildTurnPrompt(busy(), "p4", materials, { folder, served, drafts: [{ draftId: "d1", participantId: "p1", text: "DRAFT", reasoning: "WHY" }] });
    expect(p.match(CYR)).toBeNull();
    for (const h of ["# Discussion framing\nFRAMING-TEXT", "# Your role\nYou are participant p4 “Delta”.", "# Participants\n", "# Protocol rules\n", "# Topic\nTOPIC-TEXT",
      "# Owner's materials\n", "## Material m1: notes.md\nMATERIAL-TEXT", "# Owner's folder\n", "# Requested files\n", "# Independent drafts\n", "# Owner's remarks\n",
      "# Questions to the owner\n", "# Current version of the solution\nVersion 1, author p1. Round 2 of 3.\n\nSOLUTION-V1", "# Open questions to you\n- q2 from p1: Agree?", "# Turn log\n"]) {
      expect(p).toContain(h);
    }
    expect(p).toContain("- p3 “Gamma” — replaced by participant p4");
    expect(p).toContain("- p2 “Beta” — dropped out");
    expect(p).toContain("(agree with questions counted as object)");
    expect(p).toContain("Read files: d/a.txt");
    expect(p).toContain("(not in the owner's folder)");
    expect(p).toContain("(over five names per request)");
    expect(p).toContain("d/deep/x/ — files: ");
    expect(p).toContain("- q5 from p4, turn 2 — left unanswered, decide yourselves: Mobile?");
    expect(p).toContain("  Owner's answer: Friday");
    expect(p).toContain(protocolRules("en"));
    expect(p).not.toMatch(/answer in (English|Russian)|reply in (English|Russian)|respond in/i);
  });

  it("protocol terms and JSON format are the same", () => {
    const en = protocolRules("en"), ru = protocolRules("ru");
    for (const term of ['"stance": "amend" | "agree" | "object"', '"reasoning"', '"solution"', '"answers": [{ "questionId": "q1"', '"questions": [{ "to": "p2"', '"files": []', '"owner"']) {
      expect(en).toContain(term);
      expect(ru).toContain(term);
    }
    const keys = (s: string) => [...s.matchAll(/"(\w+)":/g)].map((m) => m[1]);
    expect(keys(en)).toEqual(keys(ru));
    expect(keys(draftRules("en"))).toEqual(keys(draftRules("ru")));
    expect(keys(draftRules("en"))).toEqual(["stance", "reasoning", "solution", "answers", "questions", "files"]);
  });

  it("Independent draft: rules and headings in English, JSON fields and amend are the same", () => {
    const s = mkState("en").session!;
    const p = buildDraftPrompt(s, "p1", materials, { folder, served: serveFiles(folder, ["d/a.txt"], "en") });
    expect(p.match(CYR)).toBeNull();
    expect(p).toContain(`# Independent draft rules\n${draftRules("en")}`);
    expect(p).toContain('"stance": "amend"');
    expect(p).toContain("# Requested files\n");
  });

  it("Repeat request after an invalid response: English heading and errors, original request in full", () => {
    const s = mkState("en");
    const base = buildTurnPrompt(s, "p1");
    const r = parseTurnResponse(JSON.stringify({ stance: "agree", reasoning: " ", solution: "x", answers: [], questions: [{ to: "p1", text: "q" }], files: [] }), s, "p1");
    expect(r.ok).toBe(false);
    const errors = (r as { errors: string[] }).errors;
    const p = buildCorrectionPrompt(base, "z".repeat(2500), errors, "en");
    expect(p.startsWith(`${base}\n\n# Fix your previous answer\nYour previous answer was not accepted. Errors:\n`)).toBe(true);
    expect(p).toContain("- reasoning: string must not be blank");
    expect(p).toContain(`… [truncated, 2500 characters in total]`);
    expect(p.match(CYR)).toBeNull();
  });

  it("Preview in English: sections in English, file texts unchanged", () => {
    const en = buildMaterialsPreview({ language: "en", materials, workspace: folder, skipped: [], left: [] });
    const ru = buildMaterialsPreview({ language: "ru", materials, workspace: folder, skipped: [], left: [] });
    expect(en.initial).toContain("# Owner's materials\n");
    expect(en.manifest).toContain("# Owner's folder\n");
    expect(ru.initial).toContain("# Материалы владельца\n");
    expect(en.initial).toContain("MATERIAL-TEXT");
    expect({ ...en, initial: null, manifest: null }).toEqual({ ...ru, initial: null, manifest: null });
  });
});

describe("Context limit is counted in characters of the session language", () => {
  const journalOf = (p: string) => p.slice(p.indexOf("# Turn log\n") + "# Turn log\n".length);
  const entries = (j: string) => j.replace(/^\[Early turns omitted[^\n]*\n/, "");

  it("English session journal: early turns omitted, remainder not longer than the limit, English note", () => {
    const full = journalOf(buildTurnPrompt(busy(), "p1"));
    const total = entries(full).split("\n\n").reduce((n, e) => n + e.length, 0);
    for (const limit of [50, 200, 400, total - 1]) {
      const j = journalOf(buildTurnPrompt(busy(limit), "p1"));
      expect(j).toMatch(/^\[Early turns omitted due to the context limit: [1-3]\]/);
      // The limit counts entry texts without separators, as before.
      expect(entries(j).split("\n\n").reduce((n, e) => n + e.length, 0)).toBeLessThanOrEqual(limit);
    }
    expect(journalOf(buildTurnPrompt(busy(total), "p1"))).toBe(full);
  });

  it("Rules are outside the limit: with contextChars below the length of the English rules, they are present in full", () => {
    const limit = 100;
    expect(limit).toBeLessThan(protocolRules("en").length);
    const p = buildTurnPrompt(busy(limit), "p1");
    expect(p).toContain(`# Protocol rules\n${protocolRules("en")}`);
    expect(p).toContain("# Topic\nTOPIC-TEXT");
  });

  it("rule lengths in two languages (for Result)", () => {
    const len = { rulesEn: protocolRules("en").length, rulesRu: protocolRules("ru").length, draftEn: draftRules("en").length, draftRu: draftRules("ru").length };
    console.info(`длины правил: ${JSON.stringify(len)}`);
    expect(len.rulesEn).toBeGreaterThan(0);
  });
});

describe("Positions on the current version: English session", () => {
  it("English session: section Positions on the current version, positions and notes in English, arguments verbatim", () => {
    const long = `OBJ-P4 ${"z".repeat(2100)}`;
    const s = mkState("en", {
      versions: [{ number: 1, text: "SOLUTION-V1", authorId: "p1", turn: 1 }], round: 2,
      turns: [
        turn(1, { stance: "amend", newVersion: true, questions: [{ id: "q1", to: "p4", text: "Why?" }] }),
        turn(2, { participantId: "p4", reasoning: long, answers: [{ questionId: "q1", text: "Because." }] }),
      ],
      questions: [{ id: "q1", from: "p1", to: "p4", text: "Why?", turn: 1, status: "answered", answer: null }],
      agreed: ["p1"],
    }, 1);
    const p = buildTurnPrompt(s, "p1");
    expect(p.match(CYR)).toBeNull();
    expect(p).toContain("# Positions on the current version\n");
    expect(p).toContain("- p1 “Alpha” — this is you: agrees");
    expect(p).toContain(`- p4 “Delta”: objects (turn 2): ${long.slice(0, 2000)}… [showing the first 2000 of ${long.length} characters, turn 2]`);
    const full = buildTurnPrompt({ ...s, session: { ...s.session!, limits: { ...s.session!.limits, contextChars: 100000 } } }, "p1");
    expect(full).toContain("Answers:\n- q1 — question from p1, turn 1: “Why?”\n  Answer: Because.");
    const none = buildTurnPrompt({ ...s, agreed: [] }, "p4");
    expect(none).toContain("- p1 “Alpha”: no current position on version 1");
  });
});

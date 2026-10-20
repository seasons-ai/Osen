import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";
import { foldEvents } from "@model-council/core/protocol";
import type { SessionEvent } from "@model-council/core/protocol";
import { FeedView } from "./Feed.tsx";

// Own seeded generator, as in shared/settings.property.test.ts: fast-check is not a repository dependency.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;
const SEEDS = 300;

// Recorded texts: Russian, English, mixed, empty, one character, very long, markup, matching catalog labels.
const TEXTS = [
  "таймаут ответа", "connection reset by peer", "ошибка вызова: error 500", "", "я", "x", "ж".repeat(4000), "a".repeat(3000),
  "<b>&\"'</b>", "<script", "&lt;b&gt;", "<i", "a < b > c", "причина не указана", "no reason given", "Согласия нет", "No consensus", "Ход 7", "Turn 7",
];
const KINDS = ["timeout", "call_error", "invalid_response"] as const;
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

// Labels have no escapable characters, so esc(label) matches them in the raw markup. Labels that must not appear in the other language (not part of the recorded text pool).
const LABELS: Record<Language, { own: string[]; other: string[] }> = {
  en: { own: ["dropped out:", "attempt 1", "Retried.", "Owner", "turn 1"], other: ["выбыл:", "попытка", "Повтор.", "Владелец", "ход 1"] },
  ru: { own: ["выбыл:", "попытка 1", "Повтор.", "Владелец", "ход 1"], other: ["dropped out:", "attempt 1", "Retried.", "Owner", "turn 1"] },
};

describe("„Discussion“ screen in the selected language: recorded text is not translated", () => {
  afterEach(() => setProcessLanguage("ru"));

  it("Feed recorded text and active-language labels: recorded texts verbatim, surrounding labels only in the active language", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = mulberry32(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const msg1 = pick(TEXTS), msg2 = pick(TEXTS), dr2 = pick(TEXTS), dr3 = pick(TEXTS), say = pick(TEXTS);
      const kind = pick(KINDS), kind2 = pick(KINDS);
      const bodies: Body[] = [
        { type: "session_created", pid: 1, session: { id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "T", templateId: null, framing: "",
          participants: [1, 2, 3].map((i) => ({ id: `p${i}`, name: `N${i}`, providerId: "scripted", model: "m", role: null })), limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 } } },
        { type: "turn_started", turn: 1, round: 1, participantId: "p1" },
        { type: "turn_failed", turn: 1, round: 1, participantId: "p1", attempt: 1, kind, message: msg1 },
        { type: "turn_completed", turn: 1, round: 1, participantId: "p1", stance: "amend", normalized: false, reasoning: "r", solution: "s", version: 1, questions: [], answers: [], attempts: 2, usage: {}, durationMs: 1 },
        { type: "owner_message", id: "o1", text: say, afterTurn: 1, requestId: "r1" },
        { type: "turn_started", turn: 2, round: 1, participantId: "p2" },
        { type: "turn_failed", turn: 2, round: 1, participantId: "p2", attempt: 1, kind: kind2, message: msg2 },
        { type: "participant_dropped", participantId: "p2", reason: dr2 },
        { type: "participant_dropped", participantId: "p3", reason: dr3 },
      ] as Body[];
      const state = foldEvents(bodies.map((b, i) => ({ ...b, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent));
      for (const language of ["en", "ru"] as const) {
        setProcessLanguage(language);
        const h = renderToStaticMarkup(<FeedView state={state} running={false} live={null} unseen={0} onJump={() => {}} />);
        const where = `seed ${seed}, ${language}`;
        for (const t of [msg1, msg2, dr2, say]) if (t !== "") expect(h, `${where}: ${JSON.stringify(t.slice(0, 20))}`).toContain(esc(t));
        // Departure of p3 without a turn does not get into the feed, but the reason of p2 appears next to its label
        for (const l of LABELS[language].own) expect(h, `${where}: подпись ${l}`).toContain(esc(l));
        for (const l of LABELS[language].other) expect(h, `${where}: чужая подпись ${l}`).not.toContain(esc(l));
      }
    }
  });
});

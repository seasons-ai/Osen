import { foldEvents } from "@model-council/core/protocol";
import type { SessionEvent, SessionState } from "@model-council/core/protocol";
import type { StoredStatus } from "@model-council/core";

// Sessions for the export reference: together they pass through all branches of sessionMarkdown.
// The references testdata/export-ru-*.md were taken from the code before change 60; dates in them are replaced with the markers {{DATE}} and {{WHEN}}.
type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;

export const SNAPSHOT_CREATED_AT = "2026-10-09T12:00:00Z";
export const SNAPSHOT_SELECTED_AT = "2026-10-09T12:34:56Z";

const fold = (bodies: Body[]): SessionState =>
  foldEvents(bodies.map((b, i) => ({ ...b, seq: i + 1, ts: b.type === "owner_selected_version" ? SNAPSHOT_SELECTED_AT : SNAPSHOT_CREATED_AT }) as SessionEvent));

const created = (materials: { id: string; name: string; chars: number; sha256: string }[]): Body => ({
  type: "session_created", pid: 1,
  session: {
    id: "s1", createdAt: SNAPSHOT_CREATED_AT, origin: "cli", topic: "Цена продукта", templateId: null, framing: "",
    participants: [
      { id: "p1", name: "Первый", providerId: "scripted", model: "m1", role: "критик" },
      { id: "p2", name: "Второй", providerId: "scripted", model: "m2", role: null },
      { id: "p3", name: "Третий", providerId: "scripted", model: "m3", role: null },
    ],
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
    ...(materials.length ? { materials } : {}),
  },
});
const started = (turn: number, round: number, participantId: string): Body => ({ type: "turn_started", turn, round, participantId });
const done = (
  turn: number, round: number, participantId: string, stance: "amend" | "agree" | "object", version: number, reasoning: string,
  x: { questions?: { id: string; to: string; text: string }[]; answers?: { questionId: string; text: string }[] } = {},
): Body => ({
  type: "turn_completed", turn, round, participantId, stance, normalized: false, reasoning,
  solution: stance === "amend" ? `Решение версии ${version}: цена 100 рублей.` : null, version, questions: x.questions ?? [], answers: x.answers ?? [],
  attempts: 1, usage: {}, durationMs: 5,
});

const rich: Body[] = [
  created([{ id: "m1", name: "заметки.md", chars: 1, sha256: "c".repeat(64) }, { id: "m2", name: "b.txt", chars: 5, sha256: "d".repeat(64) }]),
  { type: "owner_message", id: "o1", text: "Начните с цены", afterTurn: 0, requestId: "r-o1" } as Body,
  started(1, 1, "p1"),
  done(1, 1, "p1", "amend", 1, "Первый аргумент.", { questions: [
    { id: "q1", to: "owner", text: "Какой бюджет?" }, { id: "q2", to: "p2", text: "Сколько стоит?" },
    { id: "q3", to: "p3", text: "Когда срок?" }, { id: "q4", to: "owner", text: "Нужна ли скидка?" }, { id: "q5", to: "p1", text: "Открытый вопрос?" },
  ] }),
  { type: "owner_message", id: "o2", text: "Бюджет сто тысяч. И срок — месяц.", afterTurn: 1, requestId: "r-o2", answers: [{ questionId: "q1", text: "Бюджет сто тысяч" }] } as Body,
  { type: "question_closed", questionId: "q1", reason: "answered" } as Body,
  started(2, 1, "p2"),
  { type: "turn_failed", turn: 2, round: 1, participantId: "p2", attempt: 1, kind: "invalid_response", message: "мусор в ответе." } as Body,
  started(2, 1, "p2"),
  done(2, 1, "p2", "amend", 2, "Второй аргумент.", { answers: [{ questionId: "q2", text: "Сто рублей" }] }),
  { type: "question_closed", questionId: "q2", reason: "answered" } as Body,
  started(3, 1, "p3"),
  { type: "turn_failed", turn: 3, round: 1, participantId: "p3", attempt: 1, kind: "timeout", message: "нет ответа за 60 с" } as Body,
  { type: "participant_dropped", participantId: "p3", reason: "таймаут хода" } as Body,
  { type: "question_closed", questionId: "q3", reason: "unanswered" } as Body,
  { type: "question_closed", questionId: "q4", reason: "unanswered" } as Body,
  started(4, 2, "p1"),
  done(4, 2, "p1", "object", 2, "Слишком дорого."),
  { type: "session_finished", status: "no_consensus", version: 2, agreed: ["p2"], objectors: [{ participantId: "p1", reasoning: "Слишком дорого." }], reason: "лимит кругов исчерпан" } as Body,
  { type: "owner_selected_version", version: 1, statusAtSelection: "no_consensus", note: "Первая проще" } as Body,
  { type: "session_resumed", pid: 2, maxRounds: 5, replacements: [{ oldParticipantId: "p3", participant: { id: "p4", name: "Новый", providerId: "scripted", model: "m4", role: null } }] } as Body,
  started(5, 3, "p4"),
  done(5, 3, "p4", "object", 2, "", { questions: [{ id: "q6", to: "p2", text: "Вопрос заменённому?" }] }),
  { type: "session_finished", status: "no_consensus", version: 2, agreed: ["p2"], objectors: [{ participantId: "p1", reasoning: "Слишком дорого." }, { participantId: "p4", reasoning: "" }] } as Body,
];

// Failure before the first version: "No solution.", the reason, a participant dropped without a reason; "No turns." is not reached because of the failure line.
const failed: Body[] = [
  created([{ id: "m1", name: "один.md", chars: 21, sha256: "e".repeat(64) }]),
  started(1, 1, "p1"),
  { type: "turn_failed", turn: 1, round: 1, participantId: "p1", attempt: 1, kind: "call_error", message: "код 1" } as Body,
  { type: "participant_dropped", participantId: "p1", reason: "ошибка вызова" } as Body,
  { type: "session_finished", status: "failed", version: null, agreed: [], objectors: [], reason: "Активных участников осталось меньше двух.", reasonCode: "insufficient_active_participants" } as Body,
];

// Creation only: "No turns.", "No solution.", the status "interrupted".
const empty: Body[] = [created([])];

export const SNAPSHOT_CASES: { name: string; state: SessionState; status: StoredStatus }[] = [
  { name: "rich", state: fold(rich), status: "no_consensus" },
  { name: "failed", state: fold(failed), status: "failed" },
  { name: "empty", state: fold(empty), status: "interrupted" },
];

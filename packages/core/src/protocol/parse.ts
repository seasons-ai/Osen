import { sessionLanguage, turnResponseSchema } from "./schema.ts";
import type { Stance } from "./schema.ts";
import { promptMessages } from "../messages/prompt.ts";
import type { Language } from "../i18n/language.ts";
import { OWNER_ID, activeParticipantIds, currentVersion, openQuestionsFor } from "./state.ts";
import type { SessionState } from "./state.ts";

export const RAW_LIMIT = 2000;

export interface ParsedTurn {
  stance: Stance;
  normalized: boolean;
  reasoning: string;
  solution: string | null;
  answers: { questionId: string; text: string }[];
  questions: { to: string; text: string }[];
}

export type ParseResult = { ok: true; turn: ParsedTurn } | { ok: false; errors: string[] };

function tryObject(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// End of the object starting at position start, taking nesting and strings into account; -1 if there is no pair.
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === "\"") inString = false;
    } else if (c === "\"") inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

// Bodies of fenced blocks in source order: "```", an info string up to a newline or backtick, the body up to the next "```"
// (its leading newline is trimmed by the caller). A forward scan: once a fence has no closing "```", no later fence can have one.
function* fencedBodies(raw: string): Generator<string> {
  for (let open = raw.indexOf("```"); open !== -1; ) {
    let body = open + 3;
    while (body < raw.length && raw[body] !== "\n" && raw[body] !== "`") body++;
    const close = raw.indexOf("```", body);
    if (close === -1) return;
    yield raw.slice(body, close);
    open = raw.indexOf("```", close + 3);
  }
}

export function extractJsonObject(raw: string): Record<string, unknown> | undefined {
  const whole = tryObject(raw.trim());
  if (whole) return whole;
  for (const body of fencedBodies(raw)) {
    const obj = tryObject(body.trim());
    if (obj) return obj;
  }
  for (let i = raw.indexOf("{"); i !== -1; i = raw.indexOf("{", i + 1)) {
    const end = matchingBrace(raw, i);
    if (end === -1) continue;
    const obj = tryObject(raw.slice(i, end + 1));
    if (obj) return obj;
  }
  return undefined;
}

/** File names from the reply to the request (field files); null if there is no request. The other fields are not checked. */
export function parseFileRequest(raw: string): string[] | null {
  const files = extractJsonObject(raw)?.files;
  if (!Array.isArray(files)) return null;
  const names = files.filter((f): f is string => typeof f === "string").map((f) => f.trim()).filter((f) => f !== "");
  return names.length > 0 ? names : null;
}

// Error descriptions are in the session language: they go into the fix request and into the record of the turn failure.
export function parseTurnResponse(raw: string, state: SessionState, participantId: string): ParseResult {
  const language = state.session ? sessionLanguage(state.session) : "ru";
  const m = promptMessages(language);
  const obj = extractJsonObject(raw);
  if (!obj) return { ok: false, errors: [m.errNoJson] };

  const parsed = turnResponseSchema(language).safeParse(obj);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)),
    };
  }
  const r = parsed.data;

  const errors: string[] = [];
  if (currentVersion(state) === null && r.stance !== "amend") {
    errors.push(m.errFirstAmend);
  }
  const active = activeParticipantIds(state);
  for (const q of r.questions) {
    if (q.to === OWNER_ID) continue;
    if (q.to === participantId) errors.push(m.errSelfQuestion);
    else if (!state.participants.some((p) => p.id === q.to)) {
      errors.push(m.errUnknownTarget(q.to));
    } else if (!active.includes(q.to)) errors.push(m.errDroppedTarget(q.to));
  }
  const open = openQuestionsFor(state, participantId);
  for (const q of open) {
    if (!r.answers.some((a) => a.questionId === q.id)) errors.push(m.errNoAnswer(q.id, q.text));
  }
  if (errors.length) return { ok: false, errors };

  const answers: ParsedTurn["answers"] = [];
  for (const q of open) {
    const a = r.answers.find((x) => x.questionId === q.id);
    if (a) answers.push({ questionId: a.questionId, text: a.text });
  }
  const normalized = r.stance === "agree" && r.questions.length > 0;
  return {
    ok: true,
    turn: {
      stance: normalized ? "object" : r.stance,
      normalized,
      reasoning: r.reasoning,
      solution: r.solution,
      answers,
      questions: r.questions.map((q) => ({ to: q.to, text: q.text })),
    },
  };
}

export interface ParsedDraft { solution: string; reasoning: string }
export type DraftParseResult = { ok: true; draft: ParsedDraft } | { ok: false; errors: string[] };

export function parseDraftResponse(raw: string, language: Language): DraftParseResult {
  const m = promptMessages(language);
  const obj = extractJsonObject(raw);
  if (!obj) return { ok: false, errors: [m.errNoJson] };

  const parsed = turnResponseSchema(language).safeParse(obj);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)),
    };
  }
  const r = parsed.data;

  const errors: string[] = [];
  if (r.stance !== "amend") errors.push(m.errDraftStance);
  if (r.questions.length > 0) errors.push(m.errDraftQuestions);
  if (r.answers.length > 0) errors.push(m.errDraftAnswers);
  if (errors.length) return { ok: false, errors };
  return { ok: true, draft: { solution: r.solution!, reasoning: r.reasoning } };
}

export function truncateRaw(raw: string, language: Language, limit: number = RAW_LIMIT): string {
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}${promptMessages(language).truncated(raw.length)}`;
}

export function buildCorrectionPrompt(prompt: string, raw: string, errors: string[], language: Language): string {
  return promptMessages(language).correction(prompt, errors.map((e) => `- ${e}`).join("\n"), truncateRaw(raw, language));
}

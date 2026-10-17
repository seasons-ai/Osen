import { FOLDER_LIMITS, folderMap, folderStats } from "./folder.ts";
import type { FolderFile, ServedFile } from "./folder.ts";
import { activeParticipantIds, currentVersion, openQuestionsFor, OWNER_ID } from "./state.ts";
import type { SessionState, TurnRecord } from "./state.ts";
import { sessionLanguage } from "./schema.ts";
import type { Session } from "./schema.ts";
import { promptMessages } from "../messages/prompt.ts";
import type { Language } from "../i18n/language.ts";

// Request texts are in the session language (sessionLanguage); catalog messages/prompt.ts.
export const protocolRules = (language: Language): string => promptMessages(language).protocolRules;
export const draftRules = (language: Language): string => promptMessages(language).draftRules;

// Limits of the positions section and of the question text in a reply: not a setting; the request size does not depend on configuration.
export const OBJECTION_MAX_CHARS = 2000;
export const ANSWERED_QUESTION_MAX_CHARS = 500;

function answerLine(state: SessionState, a: { questionId: string; text: string }, language: Language): string {
  const m = promptMessages(language);
  const q = state.questions.find((x) => x.id === a.questionId);
  if (!q) return `- ${a.questionId}: ${a.text}`;
  if (q.text.length <= ANSWERED_QUESTION_MAX_CHARS) return m.answerWithQuestion(q.id, q.from, q.turn, q.text, a.text);
  const clip = m.clipped(ANSWERED_QUESTION_MAX_CHARS, q.text.length, q.turn);
  return m.answerWithClippedQuestion(q.id, q.from, q.text.slice(0, ANSWERED_QUESTION_MAX_CHARS), clip, a.text);
}

// "Positions on the current version" section: built from the state, outside journal() and the contextChars limit; null — there is no version.
function positionsSection(state: SessionState, readerId: string, language: Language): string | null {
  const v = currentVersion(state);
  const session = state.session;
  if (!v || !session) return null;
  const m = promptMessages(language);
  const lines = activeParticipantIds(state).map((id) => {
    const name = session.participants.find((p) => p.id === id)?.name ?? id;
    const who = m.participant(id, name, id === readerId ? m.isYou : "");
    if (state.agreed.includes(id)) return `${who}: ${m.posAgrees}`;
    const last = state.turns.findLast((t) => t.participantId === id && t.version === v.number);
    if (last?.stance !== "object") return `${who}: ${m.posNone(v.number)}`;
    const text = last.reasoning.length <= OBJECTION_MAX_CHARS
      ? last.reasoning
      : `${last.reasoning.slice(0, OBJECTION_MAX_CHARS)}… ${m.clipped(OBJECTION_MAX_CHARS, last.reasoning.length, last.turn)}`;
    return `${who}: ${m.posObjects(last.turn)}${last.normalized ? m.normalized : ""}: ${text}`;
  });
  return m.positionsSection(v.number, lines.join("\n"));
}

function turnEntry(state: SessionState, t: TurnRecord, language: Language): string {
  const m = promptMessages(language);
  const name = state.session?.participants.find((p) => p.id === t.participantId)?.name ?? t.participantId;
  let head = m.turnHead(t.turn, t.round, t.participantId, name, t.stance);
  if (t.normalized) head += m.normalized;
  if (t.newVersion) head += m.newVersion(t.version);
  const lines = [head, m.arguments(t.reasoning)];
  if (t.answers.length > 0) lines.push(m.answers, ...t.answers.map((a) => answerLine(state, a, language)));
  if (t.questions.length > 0) lines.push(m.questions, ...t.questions.map((q) => `- ${q.id} → ${q.to}: ${q.text}`));
  if (t.filesRead && t.filesRead.length > 0) lines.push(m.filesRead(t.filesRead.map((f) => f.name).join(", ")));
  return lines.join("\n");
}

// The limit counts the characters of journal records in the session language; rules and headings are not included in it.
function journal(state: SessionState, limit: number, language: Language): string {
  const m = promptMessages(language);
  if (state.turns.length === 0) return m.noTurns;
  const entries = state.turns.map((t) => turnEntry(state, t, language));
  let total = entries.reduce((s, e) => s + e.length, 0);
  let dropped = 0;
  while (total > limit && dropped < entries.length) total -= entries[dropped++]!.length;
  const kept = entries.slice(dropped);
  const note = dropped > 0 ? [m.droppedTurns(dropped)] : [];
  return [...note, kept.join("\n\n")].filter((s) => s !== "").join("\n");
}

export interface PromptMaterial { id: string; name: string; text: string }

export interface DraftText { draftId: string; participantId: string; text: string; reasoning: string }

export interface TurnPromptExtras { folder?: readonly FolderFile[]; served?: readonly ServedFile[]; drafts?: readonly DraftText[] }

/** Sum of characters of draft texts and rationales. */
export function draftsChars(drafts: readonly { text: string; reasoning: string }[]): number {
  return drafts.reduce((s, d) => s + d.text.length + d.reasoning.length, 0);
}

/** "Independent drafts" section of a regular request; null — there are no drafts. Not truncated. */
export function draftsSection(session: Session, drafts: readonly DraftText[]): string | null {
  if (drafts.length === 0) return null;
  const m = promptMessages(sessionLanguage(session));
  const items = drafts.map((d) => {
    const name = session.participants.find((p) => p.id === d.participantId)?.name ?? d.participantId;
    return m.draft(d.draftId, d.participantId, name, d.text, d.reasoning);
  });
  return m.drafts(items.join("\n\n"));
}

function servedSection(served: readonly ServedFile[], language: Language): string | null {
  if (served.length === 0) return null;
  const m = promptMessages(language);
  const items = served.map((f) => `${m.servedFile(f.name)}
${f.note !== null ? `(${f.note})
` : ""}${f.text}`);
  return m.served(items.join("\n\n"));
}

/** "Owner materials" section of a turn request; null — there are no materials. */
export function materialsSection(materials: readonly PromptMaterial[], language: Language): string | null {
  if (materials.length === 0) return null;
  const m = promptMessages(language);
  return m.materials(materials.map((x) => m.material(x.id, x.name, x.text)).join("\n\n"));
}

/** "Owner folder" section of a turn request (header and folderMap listing); null — there is no folder. */
export function folderSection(folder: readonly FolderFile[], language: Language): string | null {
  if (folder.length === 0) return null;
  const st = folderStats(folder);
  return promptMessages(language).folder(st.files, st.chars, FOLDER_LIMITS.filesPerRequest, FOLDER_LIMITS.readChars, folderMap(folder, language));
}

export interface MaterialsPreview {
  /** Exact text of the "Owner materials" section; null — there are no initial materials. */
  initial: string | null;
  /** Exact text of the "Owner folder" section; null — there is no folder. */
  manifest: string | null;
  /** Folder size; null — there is no folder. */
  folder: { files: number; chars: number } | null;
  /** All folder files by name. initial — the file text is in the initial materials; reason — why it did not get in (from left), otherwise null. */
  available: { name: string; chars: number; initial: boolean; reason: string | null }[];
  /** Skipped during collection, with a reason. */
  skipped: { name: string; reason: string }[];
  /** Not in the initial materials and absent from the folder. */
  left: { name: string; reason: string }[];
}

export interface MaterialsPreviewInput {
  /** Active language at the moment of the preview; a running session collects its sections in its own language. */
  language: Language;
  materials: readonly PromptMaterial[];
  workspace: readonly FolderFile[];
  skipped: readonly { name: string; reason: string }[];
  left: readonly { name: string; reason: string }[];
}

/** Materials preview data; a pure function: the file texts of the folder do not get into the result. */
export function buildMaterialsPreview(input: MaterialsPreviewInput): MaterialsPreview {
  const { materials, workspace } = input;
  const inMaterials = new Set(materials.map((m) => m.name));
  const reasons = new Map(input.left.map((l) => [l.name, l.reason]));
  const inWorkspace = new Set(workspace.map((f) => f.name));
  const available = workspace.map((f) => {
    const initial = inMaterials.has(f.name);
    return { name: f.name, chars: f.text.length, initial, reason: initial ? null : (reasons.get(f.name) ?? null) };
  }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    initial: materialsSection(materials, input.language),
    manifest: folderSection(workspace, input.language),
    folder: workspace.length > 0 ? folderStats(workspace) : null,
    available,
    skipped: input.skipped.map((s) => ({ name: s.name, reason: s.reason })),
    left: input.left.filter((l) => !inWorkspace.has(l.name)).map((l) => ({ name: l.name, reason: l.reason })),
  };
}

export function buildTurnPrompt(
  state: SessionState, participantId: string, materials: readonly PromptMaterial[] = [], extras: TurnPromptExtras = {},
): string {
  const session = state.session;
  if (session === null) throw new Error(promptMessages().noSession);
  const me = session.participants.find((p) => p.id === participantId);
  if (!me) throw new Error(promptMessages().unknownParticipant("buildTurnPrompt", participantId));
  const language = sessionLanguage(session);
  const m = promptMessages(language);

  const sections: string[] = [];
  if (session.framing.trim() !== "") sections.push(m.framing(session.framing));

  const role = [m.youAre(me.id, me.name), ...(me.role !== null ? [m.role(me.role)] : [])];
  sections.push(m.roleSection(role.join("\n")));

  const people = session.participants.map((p) => {
    const ps = state.participants.find((s) => s.id === p.id);
    const mark = ps?.replacedBy !== undefined ? m.replacedBy(ps.replacedBy) : ps?.status === "dropped" ? m.dropped : "";
    return m.participant(p.id, p.name, `${mark}${p.id === participantId ? m.isYou : ""}`);
  });
  sections.push(m.participantsSection(people.join("\n")));
  sections.push(m.rulesSection(m.protocolRules));
  sections.push(m.topic(session.topic));

  const materialsText = materialsSection(materials, language);
  if (materialsText !== null) sections.push(materialsText);

  const folder = extras.folder ?? [];
  if (folder.length > 0) {
    sections.push(folderSection(folder, language)!);
    const servedText = servedSection(extras.served ?? [], language);
    if (servedText !== null) sections.push(servedText);
  }

  const draftsText = draftsSection(session, extras.drafts ?? []);
  if (draftsText !== null) sections.push(draftsText);

  if (state.ownerMessages.length > 0) {
    sections.push(m.ownerMessages(state.ownerMessages.map((x) => m.ownerMessage(x.id, x.afterTurn, x.text)).join("\n\n")));
  }

  const ownerQs = state.questions.filter((q) => q.to === OWNER_ID);
  if (ownerQs.length > 0) {
    const items = ownerQs.map((q) => {
      const label = q.status === "open" ? m.qOpen : q.status === "answered" ? m.qAnswered : m.qUnanswered;
      const reply = q.status === "answered" && q.answer !== null && q.answer !== "" ? m.ownerAnswer(q.answer) : "";
      return `${m.ownerQuestion(q.id, q.from, q.turn, label, q.text)}${reply}`;
    });
    sections.push(m.ownerQuestions(items.join("\n")));
  }

  const v = currentVersion(state);
  sections.push(m.versionSection(v ? m.version(v.number, v.authorId, state.round, session.limits.maxRounds, v.text) : m.noVersion));

  const positions = positionsSection(state, participantId, language);
  if (positions !== null) sections.push(positions);

  const open = openQuestionsFor(state, participantId).map((q) => m.openQuestion(q.id, q.from, q.text));
  sections.push(m.openQuestions(open.length > 0 ? open.join("\n") : m.none));
  sections.push(m.journalSection(journal(state, session.limits.contextChars, language)));

  return sections.join("\n\n");
}

export function buildDraftPrompt(
  session: Session, participantId: string, materials: readonly PromptMaterial[] = [], extras: TurnPromptExtras = {},
): string {
  const me = session.participants.find((p) => p.id === participantId);
  if (!me) throw new Error(promptMessages().unknownParticipant("buildDraftPrompt", participantId));
  const language = sessionLanguage(session);
  const m = promptMessages(language);

  const sections: string[] = [];
  if (session.framing.trim() !== "") sections.push(m.framing(session.framing));
  const role = [m.youAre(me.id, me.name), ...(me.role !== null ? [m.role(me.role)] : [])];
  sections.push(m.roleSection(role.join("\n")));
  sections.push(m.draftRulesSection(m.draftRules));
  sections.push(m.topic(session.topic));

  const materialsText = materialsSection(materials, language);
  if (materialsText !== null) sections.push(materialsText);

  const folder = extras.folder ?? [];
  if (folder.length > 0) {
    sections.push(folderSection(folder, language)!);
    const servedText = servedSection(extras.served ?? [], language);
    if (servedText !== null) sections.push(servedText);
  }
  return sections.join("\n\n");
}

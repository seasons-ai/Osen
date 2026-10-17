import { currentVersion } from "@model-council/core";
import type { JournalPartial, SessionState, StoredStatus } from "@model-council/core";
import { OWNER_ID } from "@model-council/core/protocol";
import { formatDate } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";
import { finishReasonView } from "../shared/finish-reason.ts";
import { partialView } from "../shared/partial.ts";
import { failureLabel, objectingParticipants, timeline } from "../shared/timeline.ts";
import type { DraftView } from "../shared/bridge.ts";
import { resultMain } from "../shared/messages/result-main.ts";
import { session as sessionMessages } from "../shared/messages/session.ts";
import { feed } from "../shared/messages/session-feed.ts";

export function sessionMarkdown(state: SessionState, status: StoredStatus, language?: Language, partial?: JournalPartial | null, drafts: readonly DraftView[] = []): string {
  const m = resultMain(language);
  const s = sessionMessages(language);
  const fd = feed(language);
  const STATUS: Record<StoredStatus, string> = {
    consensus: s.statusConsensus, no_consensus: s.statusNoConsensus, stopped: s.statusStopped,
    failed: s.statusFailed, interrupted: s.statusInterrupted, running: s.statusRunning,
  };
  const STANCE = { amend: s.stanceAmend, agree: s.stanceAgree, object: s.stanceObject } as const;
  const { session } = state;
  if (!session) throw new Error(m.noCreation);
  const name = (id: string) => id === OWNER_ID ? s.owner : session.participants.find((p) => p.id === id)?.name ?? id;
  const answerLine = (a: { questionId: string; text: string }) => {
    const q = state.questions.find((x) => x.id === a.questionId);
    return m.answerLine(a.questionId, q ? { from: name(q.from), text: q.text } : null, a.text);
  };
  const dropped = (id: string) => state.participants.find((p) => p.id === id);
  const view = partialView(partial, language);
  const b: string[] = [...(view ? [`> ${view.message}`] : []), `# ${m.docTitle}`, `## ${m.topic}`, session.topic];

  b.push([
    m.dateLine(formatDate(new Date(session.createdAt), {}, language)),
    m.statusLine(view ? view.badge : STATUS[status]),
    m.roundsLine(state.round, session.limits.maxRounds, state.turns.length),
  ].join("\n"));

  b.push(`## ${m.participants}`, session.participants.map((p, i) => {
    const d = dropped(p.id);
    const by = d?.replacedBy ? session.participants.findIndex((x) => x.id === d.replacedBy) : -1;
    const tail = by >= 0
      ? m.tailReplacedBy(by + 1, session.participants[by]!.name, d?.dropReason ? d.dropReason : null)
      : d?.status === "dropped" ? m.tailDropped(d.dropReason ?? s.reasonMissing)
      : p.replaces ? m.tailReplaces(p.replaces) : "";
    return m.participantLine(i + 1, p.name, `${p.providerId}:${p.model}`, p.role ?? m.noRole) + tail;
  }).join("\n"));

  const mats = session.materials ?? [];
  if (mats.length) {
    const total = mats.reduce((a, x) => a + x.chars, 0);
    b.push(`## ${m.materials}`, mats.map((x) => `- ${x.name} — ${s.chars(x.chars)}`).join("\n") +
      `\n\n${m.materialsTotal(mats.length, s.chars(total))}`);
  }

  const { finish } = state;
  const ver = (finish && finish.version !== null ? state.versions.find((v) => v.number === finish.version) : undefined) ?? currentVersion(state);
  const agreed = finish ? finish.agreed : state.agreed;
  b.push(`## ${m.finalSolution}`);
  if (ver) {
    b.push(m.versionLine(ver.number, name(ver.authorId), agreed.length ? agreed.map(name).join(", ") : m.nobody), ver.text);
  } else b.push(m.noSolution);
  const reason = finishReasonView(state, language); // a known reason — in words in the export language, otherwise as recorded
  if (reason) b.push(m.reason(reason));

  const objs = objectingParticipants(state, status);
  if (objs.length) {
    b.push(`## ${m.objections}`, objs.map((o) => `- ${name(o.participantId)}: ${o.reasoning ?? m.noArgument}`).join("\n"));
  }

  const sel = state.ownerSelection;
  if (sel) {
    const chosen = state.versions.find((v) => v.number === sel.version);
    const when = formatDate(new Date(sel.ts), { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }, language);
    b.push(`## ${m.ownerChoice}`, m.choiceLine(sel.version, chosen ? name(chosen.authorId) : null, when, STATUS[sel.statusAtSelection]));
    if (sel.note) b.push(m.note(sel.note));
    if (chosen) b.push(chosen.text);
  }

  b.push(`## ${m.discussionLog}`);
  const items = timeline(state);
  if (!items.length) b.push(m.noTurns);
  const versionText = (n: number) => state.versions.find((v) => v.number === n)?.text ?? "";
  const notes: string[] = []; // consecutive failure and drop-out lines form one list
  const flush = () => { if (notes.length) b.push(notes.join("\n")); notes.length = 0; };
  for (const it of items) {
    if (it.kind === "failure") {
      const f = it.failure;
      notes.push(m.failureLine(f.turn, name(f.participantId), f.attempt, failureLabel(f.kind, language), f.message.replace(/\.$/, ""), Boolean(it.retried)));
      continue;
    }
    if (it.kind === "owner") {
      flush();
      const om = it.message;
      b.push(`### ${m.ownerHead(s.owner, om.id, om.afterTurn)}`);
      for (const a of om.answers ?? []) b.push(answerLine(a));
      if (!(om.answers?.length === 1 && om.answers[0]!.text === om.text)) b.push(om.text);
      continue;
    }
    if (it.kind === "resumed") continue; // ponytail: the resume separator does not get into the export; a Markdown line is a separate change
    if (it.kind === "draft-failure") {
      const f = it.failure;
      notes.push(m.draftFailureLine(it.draftId, name(f.participantId), f.attempt, failureLabel(f.kind, language), f.message.replace(/\.$/, ""), it.retried));
      continue;
    }
    if (it.kind === "dropped" || it.kind === "draft-dropped") { notes.push(`- ${fd.droppedOut(name(it.participantId), it.reason)}`); continue; }
    flush();
    if (it.kind === "draft-phase") { b.push(`### ${fd.draftsPhase} — ${fd.draftsPhaseNote}`); continue; }
    if (it.kind === "discussion-start") {
      const n = session.participants.findIndex((p) => p.id === it.synthesizerId) + 1;
      b.push(`**${fd.discussionStarted(n, name(it.synthesizerId))}**`);
      continue;
    }
    if (it.kind === "draft") {
      const d = it.done;
      const v = drafts.find((x) => x.draftId === it.draftId);
      b.push(`### ${m.draftHead(Number(it.draftId.slice(1)), name(d.participantId), d.attempts, s.chars(d.chars))}`, d.reasoning, `**${fd.draftText}:**`,
        v?.text ?? fd.textUnavailable(v?.error ?? s.reasonMissing));
      continue;
    }
    const t = it.turn;
    b.push(`### ${m.turnHead(t.turn, t.round, name(t.participantId), STANCE[t.stance], t.newVersion ? t.version : null)}`);
    for (const a of t.answers) b.push(answerLine(a));
    b.push(t.reasoning);
    if (t.newVersion) b.push(`**${m.versionHead(t.version)}**`, versionText(t.version));
    for (const q of t.questions) {
      const st = state.questions.find((x) => x.id === q.id)?.status;
      const word = st === "answered" ? fd.qAnswered : st === "unanswered" ? (q.to === OWNER_ID ? fd.qClosedByOwner : fd.qUnanswered) : st === "replaced" ? fd.qReplaced : fd.qOpen;
      b.push(m.questionLine(q.id, name(q.to), q.text, word));
    }
  }
  flush();
  return b.join("\n\n") + "\n";
}

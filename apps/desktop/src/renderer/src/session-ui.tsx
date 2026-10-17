import type { ReactNode } from "react";
import { OWNER_ID, currentVersion, draftPhase, slotRoster, tokenUsage } from "@model-council/core/protocol";
import type { DraftSlot, Session, SessionState, TOKEN_CAP_REASON, TurnRecord } from "@model-council/core/protocol";
import type { Language } from "@model-council/core/i18n";
import { session as messages } from "../../shared/messages/session.ts";
import { finishReasonView } from "../../shared/finish-reason.ts";
import { isObjecting } from "../../shared/timeline.ts";
import { useMessages } from "./language.tsx";
import { Icon } from "./icons.tsx";
import type { IconName } from "./icons.tsx";

export const STANCE = {
  amend: { icon: "i-edit", tone: "muted" },
  agree: { icon: "i-check", tone: "info" },
  object: { icon: "i-x", tone: "danger" },
} as const satisfies Record<TurnRecord["stance"], { icon: IconName; tone: string }>;

export function stanceWord(stance: TurnRecord["stance"], language?: Language): string {
  const t = messages(language);
  return { amend: t.stanceAmend, agree: t.stanceAgree, object: t.stanceObject }[stance];
}

export function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
    const url = m[0].replace(/[.,;:!?)]+$/, "");
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<a key={m.index} href={url} target="_blank" rel="noreferrer">{url}</a>);
    last = m.index + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}


/** Declension by number: one — 1, few — 2–4, many — 5+ (11–14 — many). */
export function plural(n: number, one: string, few: string, many: string): string {
  const m100 = n % 100, m10 = n % 10;
  if (m100 >= 11 && m100 <= 14) return many;
  return m10 === 1 ? one : m10 >= 2 && m10 <= 4 ? few : many;
}

/** Tokens short: up to 1000 as is, then "x.yk" truncated down (31200 → "31.2k"). */
export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(Math.floor(n / 100) / 10).toFixed(1)}k`;
}

export const chars = (n: number, language?: Language): string => messages(language).chars(n);

/** The "materials: N" line (number mono, no icon) with a list of names and sizes; material content is not printed. */
export function MaterialsRow({ session }: { session: Session | null }): ReactNode {
  const t = useMessages(messages);
  const list = session?.materials;
  if (!list || list.length === 0) return null;
  return (
    <details className="disclosure session-materials">
      <summary>{t.materials}: <span className="mono">{list.length}</span></summary>
      <ul className="disclosure__list">
        {list.map((m) => <li key={m.id}><span className="mono">{m.name}</span><span className="muted">{t.chars(m.chars)}</span></li>)}
      </ul>
    </details>
  );
}

export function num(session: Session | null, id: string): number {
  return (session?.participants.findIndex((p) => p.id === id) ?? -1) + 1;
}

export function nameOf(session: Session | null, id: string, language?: Language): string {
  if (id === OWNER_ID) return messages(language).owner;
  return session?.participants.find((p) => p.id === id)?.name ?? id;
}

/** Name without the " (<model>)" suffix that the core adds to the provider name; the " #N" tail stays. No suffix of the recorded model — the whole name. */
export function splitName(name: string, model: string): { name: string; model: string } {
  const suffix = ` (${model})`;
  const at = name.lastIndexOf(suffix);
  const tail = at < 0 ? null : name.slice(at + suffix.length);
  if (tail === null || (tail !== "" && !/^ #\d+$/.test(tail))) return { name, model };
  return { name: name.slice(0, at) + tail, model };
}

export function bareNameOf(session: Session | null, id: string, language?: Language): string {
  const p = id === OWNER_ID ? undefined : session?.participants.find((x) => x.id === id);
  return p ? splitName(p.name, p.model).name : nameOf(session, id, language);
}

/** The model from the participant record as is (including "default"); for the owner and an unknown id — null. */
export function modelOf(session: Session | null, id: string): string | null {
  if (id === OWNER_ID) return null;
  return session?.participants.find((p) => p.id === id)?.model ?? null;
}

/** Participant color: there are 8 colors, the number after replacements may be larger — colors cycle. */
export const colorOf = (n: number): number => ((n - 1) % 8) + 1;

/** The avatar color is set only by tone (participant state); data-p is a number for markup, gives no color. */
export function Avatar({ n, active, off, tone }: { n: number; active?: boolean; off?: boolean; tone?: string }): ReactNode {
  const cls = ["avatar", active && "avatar--active", off && "avatar--off"].filter(Boolean).join(" ");
  return <span className={cls} data-p={colorOf(n)} data-tone={tone}>{n}</span>;
}

export function OwnerAvatar({ sm }: { sm?: boolean } = {}): ReactNode {
  return <span className={sm ? "avatar avatar--sm session-owner__avatar" : "avatar session-owner__avatar"}><Icon name="i-key" size="sm" /></span>;
}

/** 22 px avatar and the name without the model; no participant color — distinguished by number. */
export function Who({ session, id }: { session: Session | null; id: string }): ReactNode {
  const t = useMessages(messages);
  if (id === OWNER_ID) return <span className="session-who session-owner__who"><OwnerAvatar sm /> {t.owner}</span>;
  return <span className="session-who"><span className="avatar avatar--sm">{num(session, id)}</span> {bareNameOf(session, id)}</span>;
}

export type ParticipantPhase = "waiting" | "thinking" | "agreed" | "objecting" | "dropped";

export const PHASE: Record<ParticipantPhase, { icon: IconName | null; tone: string }> = {
  waiting: { icon: "i-clock", tone: "muted" },
  thinking: { icon: null, tone: "accent" },
  agreed: { icon: "i-check", tone: "info" },
  objecting: { icon: "i-x", tone: "danger" },
  dropped: { icon: "i-user-off", tone: "warn" },
};

/** Avatar tone is the state tone; a waiting and a dropped participant have no tone. */
export const AVATAR_TONE: Record<ParticipantPhase, string | undefined> = {
  waiting: undefined, thinking: PHASE.thinking.tone, agreed: PHASE.agreed.tone, objecting: PHASE.objecting.tone, dropped: undefined,
};

type T = ReturnType<typeof messages>;
const phaseText = (t: T, phase: ParticipantPhase): string =>
  ({ waiting: t.phaseWaiting, thinking: t.phaseThinking, agreed: t.phaseAgreed, objecting: t.phaseObjecting, dropped: t.phaseDropped }[phase]);

export const phaseWord = (phase: ParticipantPhase, language?: Language): string => phaseText(messages(language), phase);

/** The "in progress" slot: the attempt is started and not finished, no draft yet, the slot's executor is active. */
export const draftInWork = (state: SessionState, d: DraftSlot): boolean =>
  d.done === null && d.started > d.failures.length && state.participants.some((p) => p.id === d.participantId && p.status === "active");

export function participantPhase(state: SessionState, id: string, running: boolean): ParticipantPhase {
  if (state.participants.some((p) => p.id === id && p.status === "dropped")) return "dropped";
  if (running && state.currentTurn?.participantId === id) return "thinking";
  if (running && draftPhase(state) === "drafting" && state.drafts.some((d) => d.participantId === id && draftInWork(state, d))) return "thinking";
  if (state.agreed.includes(id)) return "agreed";
  if (isObjecting(state, id)) return "objecting";
  return "waiting";
}

export function PhaseBadge({ phase }: { phase: ParticipantPhase }): ReactNode {
  const t = useMessages(messages);
  const { icon, tone } = PHASE[phase];
  return (
    <span className="badge" data-tone={tone}>
      {icon ? <Icon name={icon} size="sm" /> : <span className="dots"><i /></span>} {phaseText(t, phase)}
    </span>
  );
}

export interface Progress { round: number; maxRounds: number; agreed: number; active: number; openQuestions: number; consensus: boolean; drafting: { accepted: number; total: number } | null }

export function progress(state: SessionState): Progress {
  const act = state.participants.filter((p) => p.status === "active").map((p) => p.id);
  const agreed = act.filter((id) => state.agreed.includes(id)).length;
  const openQuestions = state.questions.filter((q) => q.status === "open").length;
  const drafting = draftPhase(state) === "drafting"
    ? { accepted: state.drafts.filter((d) => d.done !== null).length, total: state.session ? slotRoster(state.session).length : 0 }
    : null;
  return {
    drafting,
    round: state.round, maxRounds: state.session?.limits.maxRounds ?? 0, agreed, active: act.length, openQuestions,
    consensus: act.length >= 2 && agreed === act.length && openQuestions === 0 && currentVersion(state) !== null,
  };
}

const TOKEN_CAP: typeof TOKEN_CAP_REASON = "token_cap";

export const stoppedByCap = (state: SessionState): boolean => state.status === "stopped" && state.finish?.reason === TOKEN_CAP;

/** Failure reason for the owner: outcomes of the independent drafts phase and the token cap — in words, the rest — as the engine recorded. */
export function failReason(state: SessionState, language?: Language): string {
  return finishReasonView(state, language) || messages(language).failGeneric;
}

export function spend(state: SessionState): { total: number; cap: number | null; incomplete: boolean } {
  const u = tokenUsage(state);
  return { total: u.total, cap: state.session?.limits.maxTotalTokens ?? null, incomplete: u.incomplete };
}

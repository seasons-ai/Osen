import type { CSSProperties, ReactNode } from "react";
import { slotRoster } from "@model-council/core/protocol";
import type { SessionState } from "@model-council/core/protocol";
import { Icon } from "./icons.tsx";
import { useMessages } from "./language.tsx";
import { feed } from "../../shared/messages/session-feed.ts";
import { AVATAR_TONE, Avatar, MaterialsRow, PhaseBadge, bareNameOf, colorOf, modelOf, participantPhase, progress, spend, num, formatTokens } from "./session-ui.tsx";

/** Agreement reset by an owner message: it was applied and no turn has finished since. */
function resetByMessage(state: SessionState): boolean {
  const last = state.ownerMessages.at(-1);
  if (last === undefined) return false;
  const doneTurn = Math.max(0, ...state.turns.map((t) => t.turn));
  return last.afterTurn >= doneTurn;
}

/** Agreement reset by a replacement: the last resume with a participant change, and no turn has finished since. */
function resetByReplacement(state: SessionState): boolean {
  const mark = state.resumes.at(-1);
  return mark?.replacements !== undefined && !state.turns.some((t) => t.turn >= mark.beforeTurn);
}

/** Agreement reset: by an owner message or by a participant replacement on resume. */
export function agreementReset(state: SessionState, running: boolean): boolean {
  return running && (resetByMessage(state) || resetByReplacement(state));
}

/** Token spend relative to the cap; null — no cap and no spend. */
export function tokenMeter(state: SessionState): { total: number; cap: number | null; incomplete: boolean; pct: number; warn: boolean } | null {
  const { total, cap, incomplete } = spend(state);
  if (cap === null) return total > 0 ? { total, cap, incomplete, pct: 0, warn: false } : null;
  return { total, cap, incomplete, pct: Math.min(100, Math.round((total / cap) * 100)), warn: total * 5 >= cap * 4 };
}

export function ParticipantsPanel({ state, running }: { state: SessionState; running: boolean }): ReactNode {
  const t = useMessages(feed);
  const { session } = state;
  if (session === null) return null;
  const p = progress(state);
  const tm = tokenMeter(state);
  const pct = p.drafting ? (p.drafting.total === 0 ? 0 : Math.round((p.drafting.accepted / p.drafting.total) * 100)) : p.active === 0 ? 0 : Math.round((p.agreed / p.active) * 100);
  return (
    <section className="session-col" aria-label={t.participants}>
      <div className="session-col__head"><span className="eyebrow">{t.participants}</span></div>
      <div className="session-people scroll-y">
        {slotRoster(session).map((s) => {
          const n = num(session, s.id);
          const replaced = s.replaces === undefined ? undefined : session.participants.find((x) => x.id === s.replaces);
          const phase = participantPhase(state, s.id, running);
          const drop = state.participants.find((x) => x.id === s.id);
          const active = phase === "thinking";
          const off = phase === "dropped";
          const model = modelOf(session, s.id);
          return (
            <div key={s.id} className={["participant session-p", active && "participant--active", off && "participant--off"].filter(Boolean).join(" ")} data-p={colorOf(n)}>
              <Avatar n={n} active={active} off={off} tone={AVATAR_TONE[phase]} />
              <div>
                <div className="participant__name">{bareNameOf(session, s.id)}{model !== null && model !== "default" && <> <span className="tag">{model}</span></>}</div>
                <div className="participant__meta">{s.role ?? t.noRole}</div>
                {replaced && <div className="muted session-p__replaces">{t.replacedP(num(session, replaced.id), replaced.name)}</div>}
                <div className="session-p__state">
                  <PhaseBadge phase={phase} />
                  {off && <span className="muted session-p__reason">{drop?.dropReason ?? t.reasonMissing}</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="session-meter">
        <div className="meter" data-tone={p.consensus ? "info" : "accent"} style={{ "--value": `${pct}%` } as CSSProperties}>
          <span className="meter__label"><span>{p.drafting ? t.draftsAccepted : t.agree}</span><span className="mono session-meter__count">{p.drafting ? t.countOf(p.drafting.accepted, p.drafting.total) : t.countOf(p.agreed, p.active)}</span></span><span className="meter__fill" />
        </div>
        <div className="session-meter__line">{t.openQuestions}: <span className="mono">{p.openQuestions}</span></div>
        {tm !== null && tm.cap !== null && (
          <div className="meter session-tokens" data-tone={tm.warn ? "warn" : "accent"} style={{ "--value": `${tm.pct}%` } as CSSProperties}>
            <span className="meter__label"><Icon name={tm.warn ? "i-alert" : "i-coins"} size="sm" /> <span className="mono">{t.countOf(tm.total, tm.cap)}</span> {t.tokensOfCap(tm.cap)}{tm.incomplete ? t.incompleteCount : ""}</span><span className="meter__fill" />
          </div>
        )}
        {tm !== null && tm.cap === null && (
          <div className="session-meter__line"><Icon name="i-coins" size="sm" /> {t.tokensSpent(tm.total)}{tm.incomplete ? t.incompleteCount : ""}</div>
        )}
        {agreementReset(state, running) && <div className="session-meter__line"><Icon name="i-info" size="sm" /> {resetByReplacement(state) ? t.resetByReplacement : t.resetByMessage}</div>}
        <MaterialsRow session={session} />
      </div>
    </section>
  );
}

export function RoundCounter({ state }: { state: SessionState }): ReactNode {
  const t = useMessages(feed);
  const { round, maxRounds, drafting } = progress(state);
  const { total, incomplete } = spend(state);
  const parts = [drafting ? t.draftsCounter : t.roundOf(Math.max(round, 1), maxRounds), t.turnsCount(state.turns.length)];
  if (total > 0) parts.push(t.tokensShort(`${incomplete ? "≥" : ""}${formatTokens(total)}`));
  return <span className="session-counter mono">{parts.join(" · ")}</span>;
}

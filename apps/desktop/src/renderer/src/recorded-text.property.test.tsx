import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import type { Language } from "@model-council/core/i18n";
import { currentVersion, foldEvents } from "@model-council/core/protocol";
import type { SessionEvent, SessionState } from "@model-council/core/protocol";
import type { StoredStatus } from "@model-council/core";
import { sessionMarkdown } from "../../main/markdown.ts";
import { resultMain } from "../../shared/messages/result-main.ts";
import { isObjecting } from "../../shared/timeline.ts";
import { Result, finalVersion } from "./Result.tsx";
import type { ResultStatus } from "./Result.tsx";

// Property: what is recorded in the journal (topic, decisions, arguments, replies, note, reasons, failure messages, names)
// gets into the export and onto the „Summary“ screen verbatim in both languages; only labels and codes are translated.
// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_SEED = 20261014;
const SESSIONS = 300;
const LANGS: Language[] = ["en", "ru"];
const CODE = "insufficient_active_participants";
const TS = "2026-01-01T00:00:00Z";
// Words without < > & " ' and http; among them words that match the catalog labels of both languages.
const WORDS = ["Статус", "Status", "выбыл", "dropped out", "Версия", "Version", "Решения нет", "No solution", "причина не указана", "no reason given",
  "Владелец", "Owner", "цена", "price", "бюджет", "budget", "срок", "deadline", "Тема", "Topic"];

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;
const fold = (bodies: Body[]): SessionState =>
  foldEvents(bodies.map((b, i) => ({ ...b, seq: i + 1, ts: TS }) as SessionEvent));

type Outcome = "consensus" | "no_consensus" | "stopped" | "failed_code" | "failed_plain" | "interrupted";
const OUTCOMES: Outcome[] = ["consensus", "no_consensus", "stopped", "failed_code", "failed_plain", "interrupted"];

interface Made {
  state: SessionState; status: StoredStatus; outcome: Outcome; tags: Set<string>;
  topic: string; names: string[]; versionTexts: string[]; reasonings: string[]; ownerTexts: string[]; failureMessages: string[];
  dropReasons: string[]; materialNames: string[]; finishReason: string | null; note: string | null; failReasonCode: boolean;
}

function make(seed: number): Made {
  const rnd = mulberry32(seed);
  const int = (k: number) => Math.floor(rnd() * k);
  const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length)]!;
  const tags = new Set<string>();
  let uniq = 0;
  const pool: string[] = [];
  // Some texts are pure label words, some carry a unique marker; sometimes a text repeats in another field.
  const text = (): string => {
    if (pool.length > 0 && rnd() < 0.15) { tags.add("shared"); return pick(pool); }
    const w = Array.from({ length: 1 + int(3) }, () => pick(WORDS)).join(" ");
    const t = rnd() < 0.7 ? `${w} [${++uniq}]` : w;
    pool.push(t);
    return t;
  };

  const outcome = pick(OUTCOMES);
  const n = 2 + int(4);
  const topic = text();
  const names = Array.from({ length: n }, () => text());
  const materials = rnd() < 0.4 ? Array.from({ length: 1 + int(3) }, (_, i) => ({ id: `m${i + 1}`, name: text(), chars: int(200000), sha256: "a".repeat(64) })) : [];
  const ids = names.map((_, i) => `p${i + 1}`);
  const ev: Body[] = [{
    type: "session_created", pid: 1,
    session: {
      id: "s1", createdAt: TS, origin: "cli", topic, templateId: null, framing: "",
      participants: ids.map((id, i) => ({ id, name: names[i]!, providerId: "scripted", model: `m${i + 1}`, role: null })),
      limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
      ...(materials.length ? { materials } : {}),
    },
  }];

  const m: Made = {
    state: null as unknown as SessionState, status: "interrupted", outcome, tags, topic, names: [...names], versionTexts: [], reasonings: [], ownerTexts: [],
    failureMessages: [], dropReasons: [], materialNames: materials.map((x) => x.name), finishReason: null, note: null, failReasonCode: false,
  };
  if (materials.length) tags.add("materials");

  const active = [...ids];
  const dropped: string[] = [];
  let turn = 0, round = 1, versionNo = 0, ownerNo = 0;
  const dropProb = rnd() < 0.15 ? 0.6 : 0.12;
  const owner = () => {
    const t = text(); m.ownerTexts.push(t);
    ev.push({ type: "owner_message", id: `o${++ownerNo}`, text: t, afterTurn: turn, requestId: `r${ownerNo}` } as Body);
  };
  const failTurn = (pid: string, attempt: number) => {
    const message = text(); m.failureMessages.push(message);
    ev.push({ type: "turn_failed", turn, round, participantId: pid, attempt, kind: pick(["call_error", "timeout", "invalid_response"] as const), message } as Body);
  };
  const complete = (pid: string, forceAmend: boolean) => {
    const stance = forceAmend || versionNo === 0 ? "amend" : pick(["amend", "amend", "agree", "agree", "object", "object", "object"] as const);
    const solution = stance === "amend" ? text() : null;
    if (solution !== null) { versionNo++; m.versionTexts.push(solution); }
    const reasoning = text(); m.reasonings.push(reasoning);
    ev.push({
      type: "turn_completed", turn, round, participantId: pid, stance, normalized: false, reasoning, solution, version: versionNo,
      questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1,
    } as Body);
  };

  const turns = rnd() < 0.12 ? 0 : int(7);
  for (let i = 0; i < turns; i++) {
    if (rnd() < 0.2) owner();
    if (rnd() < 0.3 && round < 3) round++;
    const pid = active[i % active.length]!;
    turn++;
    ev.push({ type: "turn_started", turn, round, participantId: pid });
    if (active.length > 1 && rnd() < dropProb) {
      failTurn(pid, 1);
      const reason = text(); m.dropReasons.push(reason);
      ev.push({ type: "participant_dropped", participantId: pid, reason } as Body);
      active.splice(active.indexOf(pid), 1); dropped.push(pid);
      continue;
    }
    if (rnd() < 0.2) { failTurn(pid, 1); ev.push({ type: "turn_started", turn, round, participantId: pid }); }
    complete(pid, false);
  }
  if (rnd() < 0.2) owner();

  // Continuation with the replacement of a departed participant: the new participant takes a turn.
  if (dropped.length > 0 && rnd() < 0.5) {
    const old = pick(dropped);
    const np = `p${n + 1}`, name = text();
    m.names.push(name); tags.add("replaced");
    ev.push({ type: "session_finished", status: "no_consensus", version: versionNo || null, agreed: [], objectors: [] } as Body);
    ev.push({ type: "session_resumed", pid: 2, maxRounds: 5, replacements: [{ oldParticipantId: old, participant: { id: np, name, providerId: "scripted", model: "mx", role: null } }] } as Body);
    if (rnd() < 0.8) {
      turn++;
      ev.push({ type: "turn_started", turn, round, participantId: np });
      complete(np, false);
    }
  }

  // The completion summary is built from the fold: version, agreeing and objecting participants — as the engine records them.
  const st0 = fold(ev);
  if (outcome === "interrupted") m.status = "interrupted";
  else {
    const status = outcome === "failed_code" || outcome === "failed_plain" ? "failed" : outcome;
    m.status = status;
    const objectors = ids.concat(st0.session!.participants.map((p) => p.id).filter((id) => !ids.includes(id)))
      .map((id) => st0.turns.findLast((t) => t.participantId === id)).filter((t) => t?.stance === "object")
      .map((t) => ({ participantId: t!.participantId, reasoning: rnd() < 0.15 ? null : t!.reasoning }));
    const reason = outcome === "failed_code" ? `мало участников [${++uniq}]` : outcome === "failed_plain" ? text() : rnd() < 0.5 ? text() : null;
    m.finishReason = reason; m.failReasonCode = outcome === "failed_code";
    ev.push({
      type: "session_finished", status, version: currentVersion(st0)?.number ?? null, agreed: st0.agreed, objectors, reason,
      ...(outcome === "failed_code" ? { reasonCode: CODE } : {}),
    } as Body);
    if (st0.versions.length > 0 && rnd() < 0.5) {
      const kind = int(3); // 0 — no note, 1 — empty, 2 — text
      const note = kind === 2 ? text() : kind === 1 ? "" : undefined;
      if (note) m.note = note;
      tags.add(kind === 0 ? "noteAbsent" : kind === 1 ? "noteEmpty" : "note");
      ev.push({ type: "owner_selected_version", version: pick(st0.versions).number, statusAtSelection: status, ...(note === undefined ? {} : { note }) } as Body);
    }
  }
  m.state = fold(ev);
  tags.add(outcome);
  if (turns === 0) tags.add("noTurns");
  if (m.state.turns.length === 0) tags.add("noTurnsDone");
  if (m.state.versions.length === 0) tags.add("noVersions");
  if (m.state.participants.filter((p) => p.status === "active").length === 1) tags.add("oneActive");
  if (dropped.length > 0) tags.add("dropped");
  if (m.state.ownerMessages.length > 0) tags.add("ownerMessage");
  if (m.state.failures.some((f) => m.state.turns.some((t) => t.turn === f.turn))) tags.add("retry");
  return m;
}

const sessions = Array.from({ length: SESSIONS }, (_, i) => ({ seed: BASE_SEED + i, made: make(BASE_SEED + i) }));
const noop = () => {};
const screen = (state: SessionState, status: ResultStatus) =>
  renderToStaticMarkup(<Result state={state} status={status} notice={null} onCopy={noop} onExport={noop} onFeed={noop} onNew={noop} />);

afterEach(() => setProcessLanguage("ru"));

describe("recorded text generator", () => {
  it("reaches edge cases and all outcomes", () => {
    const seen = new Map<string, number>();
    for (const { made } of sessions) for (const t of made.tags) seen.set(t, (seen.get(t) ?? 0) + 1);
    for (const tag of ["consensus", "no_consensus", "stopped", "failed_code", "failed_plain", "interrupted", "noTurns", "noVersions", "oneActive", "noteAbsent", "noteEmpty", "note",
      "shared", "materials", "replaced", "dropped", "ownerMessage", "retry"]) expect(seen.get(tag) ?? 0, `нет случая ${tag}`).toBeGreaterThan(0);
  });
});

describe("„Markdown export in the selected language: recorded text is not translated“", () => {
  it("property: recorded texts stand verbatim in their sections of the file in en and ru", () => {
    for (const { seed, made: m } of sessions) {
      for (const lang of LANGS) {
        const r = resultMain(lang);
        const md = sessionMarkdown(m.state, m.status, lang);
        // Sections by "## " lines; headings come from the catalog of the selected language.
        const sec = new Map<string, string>();
        let cur = "";
        for (const line of md.split("\n")) {
          const h = /^## (?!#)(.*)$/.exec(line);
          if (h) { cur = h[1]!; sec.set(cur, ""); } else if (cur) sec.set(cur, sec.get(cur)! + line + "\n");
        }
        const at = (title: string, what: string, t: string | null | undefined, body = sec.get(title)) => {
          if (!t) return;
          expect(body?.includes(t), `зерно ${seed}, ${lang}, ${m.outcome}: ${what} «${t}» не найден в разделе «${title}»`).toBe(true);
        };
        const { state } = m;
        const parts = state.session!.participants;
        at(r.topic, "тема", m.topic);
        for (const x of m.materialNames) at(r.materials, "название материала", x);
        at(r.finalSolution, "текст итоговой версии", finalVersion(state)?.text);
        if (!m.failReasonCode) at(r.finalSolution, "причина завершения", m.finishReason);
        for (const o of state.finish?.objectors ?? []) {
          if (m.status === "no_consensus" || isObjecting(state, o.participantId)) at(r.objections, "аргумент возражающего", o.reasoning);
        }
        const sel = state.ownerSelection;
        if (sel) at(r.ownerChoice, "текст выбранной версии", state.versions.find((v) => v.number === sel.version)?.text);
        at(r.ownerChoice, "заметка", m.note);
        parts.forEach((p, i) => {
          const line = (sec.get(r.participants) ?? "").split("\n").find((l) => l.startsWith(`${i + 1}. `));
          at(r.participants, "имя участника", p.name, line);
          const d = state.participants.find((x) => x.id === p.id);
          if (d?.status === "dropped") at(r.participants, "причина выбытия", d.dropReason, line);
        });
        for (const x of m.versionTexts) at(r.discussionLog, "текст версии", x);
        for (const x of m.reasonings) at(r.discussionLog, "аргумент хода", x);
        for (const x of m.ownerTexts) at(r.discussionLog, "реплика владельца", x);
        for (const x of m.failureMessages) at(r.discussionLog, "сообщение сбоя", x);
      }
    }
  });
});

describe("„Summary“ screen in the selected language: recorded text is not translated", () => {
  it("property: recorded texts appear in the markup verbatim in en and ru; the reason code is translated, the text is not", () => {
    for (const { seed, made: m } of sessions) {
      if (m.status === "interrupted") continue;
      const { state } = m;
      const status = m.status as ResultStatus;
      const need: [string, string | null][] = [["тема", m.topic], ["заметка", m.note], ["текст итоговой версии", finalVersion(state)?.text ?? null]];
      for (const o of state.finish?.objectors ?? []) {
        if (!(status === "no_consensus" || isObjecting(state, o.participantId))) continue;
        need.push(["аргумент возражающего", o.reasoning || null], ["имя возражающего", state.session!.participants.find((p) => p.id === o.participantId)!.name]);
      }
      for (const p of state.participants) {
        if (p.status !== "dropped" || p.replacedBy !== undefined) continue;
        need.push(["причина выбывшего", p.dropReason], ["имя выбывшего", state.session!.participants.find((x) => x.id === p.id)!.name]);
      }
      if (status === "failed" && !m.failReasonCode) need.push(["причина сбоя", m.finishReason]);
      for (const lang of LANGS) {
        setProcessLanguage(lang);
        const html = screen(state, status);
        for (const [what, t] of need) if (t) expect(html.includes(t), `зерно ${seed}, ${lang}, ${m.outcome}: ${what} «${t}» не найден на экране`).toBe(true);
        if (m.failReasonCode && lang === "en") {
          expect(html, `зерно ${seed}: код причины на en`).toContain("Fewer than two active participants remain.");
          expect(html.includes(m.finishReason!), `зерно ${seed}: записанная русская причина не должна быть на en-экране`).toBe(false);
        }
      }
    }
  });
});

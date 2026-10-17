import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StoredStatus } from "@model-council/core";
import { foldEvents } from "@model-council/core/protocol";
import type { SessionEvent, SessionState } from "@model-council/core/protocol";
import { Discussion } from "./Discussion.tsx";
import { Result } from "./Result.tsx";
import { SolutionPanelView } from "./SolutionPanel.tsx";
import { participantPhase } from "./session-ui.tsx";

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;
const mk = (bodies: Body[]): SessionEvent[] => bodies.map((b, i) => ({ ...b, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent);

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case { state: SessionState; status: StoredStatus }

// Mode by seed: 0 — nobody agrees (the first turn is running), 1 — some, 2 — all, 3 — random stacks.
function generate(seed: number): Case {
  const rnd = mulberry32(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const mode = seed % 4;
  const n = 2 + int(3);
  const ids = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const cap = rnd() < 0.3;
  const bodies: Body[] = [{
    type: "session_created", pid: 1,
    session: {
      id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "t", templateId: null, framing: "",
      participants: ids.map((id) => ({ id, name: `Имя ${id}`, providerId: "scripted", model: "m", role: null })),
      limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000, ...(cap ? { maxTotalTokens: 100 } : {}) },
    },
  }];
  let turn = 0, ver = 0;
  const step = (id: string, stance: "amend" | "agree" | "object", questions: { id: string; to: string; text: string }[] = []) => {
    turn++;
    if (stance === "amend") ver++;
    bodies.push({ type: "turn_started", turn, round: 1, participantId: id });
    bodies.push({
      type: "turn_completed", turn, round: 1, participantId: id, stance, normalized: false, reasoning: "r",
      solution: stance === "amend" ? `текст v${ver}` : null, version: ver, questions, answers: [], attempts: 1,
      usage: { inputTokens: 10 + int(30), outputTokens: 10 }, durationMs: 4,
    });
  };
  const dropped = new Set<string>();
  if (mode !== 0) {
    const q = rnd() < 0.5 ? [{ id: "q1", to: ids[1]!, text: "?" }] : [];
    step("p1", "amend", q);
    if (q.length > 0) bodies.push({ type: "question_closed", questionId: "q1", reason: rnd() < 0.5 ? "answered" : "unanswered" });
    const rest = ids.slice(1);
    if (n > 2 && rnd() < 0.3) { const d = rest[int(rest.length)]!; dropped.add(d); bodies.push({ type: "participant_dropped", participantId: d, reason: "таймаут" }); }
    const live = rest.filter((id) => !dropped.has(id));
    const agreeing = mode === 2 ? live.length : mode === 1 ? Math.max(0, live.length - 1) : int(live.length + 1);
    live.forEach((id, i) => step(id, i < agreeing ? "agree" : mode === 3 && rnd() < 0.5 ? "amend" : "object"));
  }
  let status: StoredStatus;
  const r = rnd();
  if (mode === 0 || r < 0.35) {
    status = "running";
    const next = ids.filter((id) => !dropped.has(id))[int(n - dropped.size)]!;
    bodies.push({ type: "turn_started", turn: turn + 1, round: 1, participantId: next });
  } else {
    const state = foldEvents(mk(bodies));
    const all = state.agreed.length > 0 && ids.every((id) => dropped.has(id) || state.agreed.includes(id));
    const pool: StoredStatus[] = all ? ["consensus"] : ["no_consensus", "stopped", "failed", "interrupted"];
    status = pool[int(pool.length)]!;
    if (status !== "interrupted") {
      bodies.push({
        type: "session_finished", status: status as "consensus", version: ver || null, agreed: state.agreed, objectors: [],
        ...(status === "stopped" && cap ? { reason: "token_cap" } : status === "failed" ? { reason: "сбой" } : {}),
      } as Body);
    }
  }
  return { state: foldEvents(mk(bodies)), status };
}

const noop = () => {};
const render = ({ state, status }: Case): string[] => {
  const out = [
    renderToStaticMarkup(<Discussion state={state} status={status} live={null} confirming={false} stopping={false}
      onStopAsk={noop} onStopCancel={noop} onStopConfirm={noop} onResult={noop} />),
    renderToStaticMarkup(<SolutionPanelView state={state} selected={null} onSelect={noop} onCopy={noop} />),
  ];
  if (status !== "running") out.push(renderToStaticMarkup(<Result state={state} status={status} notice={null} onCopy={noop} onExport={noop} onFeed={noop} onNew={noop} />));
  return out;
};
const cards = (h: string) => h.slice(0, h.indexOf('class="session-meter"')).split('class="participant session-p').slice(1);
const SEEDS = 400;

describe("agreement and ongoing are not mixed", () => {
  it("no agreement has ok, no ongoing one has info", () => {
    const seen = { none: 0, part: 0, all: 0, cap: 0, dropped: 0, answered: 0, thinking: 0, statuses: new Set<StoredStatus>() };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const c = generate(seed);
      const { state, status } = c;
      const html = render(c);
      const running = status === "running";
      const ids = state.session!.participants.map((p) => p.id);
      const active = ids.filter((id) => !state.participants.some((p) => p.id === id && p.status === "dropped"));
      const agreed = state.agreed.length;
      seen.statuses.add(status);
      if (agreed === 0) seen.none++; else if (agreed < active.length) seen.part++; else seen.all++;
      if (state.finish?.reason === "token_cap") seen.cap++;
      if (active.length < ids.length) seen.dropped++;
      if (state.questions.some((q) => q.status === "answered")) seen.answered++;
      const msg = `зерно ${seed}, статус ${status}`;

      // Agreement and agree are not shown with the ok tone: ok does not occur on these screens at all without notifications and version comparison.
      for (const h of html) expect(h, msg).not.toContain('data-tone="ok"');
      const [disc] = html as [string];
      const badge = disc.match(/<span class="badge" data-tone="(\w+)">[^]*?<\/span>/)![1];
      if (running) expect(badge, msg).toBe("accent");
      if (status === "consensus") {
        expect(badge, msg).toBe("info");
        expect(disc, msg).toContain('<div class="alert" data-tone="info">');
        expect(html[2], msg).toMatch(/result-hero[^]*?data-tone="info"/);
      }
      expect(disc.match(/<button[^>]*btn--primary[^>]*>/g)?.filter((b) => b.includes("data-tone")) ?? [], msg).toEqual([]);

      // Indicator: info only on agreement, otherwise accent.
      const meter = disc.match(/class="meter" data-tone="(\w+)"/)![1];
      const consensus = state.agreed.length > 0 && active.every((id) => state.agreed.includes(id));
      expect(meter, msg).toBe(consensus ? "info" : "accent");

      // Participants: thinking — accent and no info, agreeing — info.
      for (const [i, card] of cards(disc).entries()) {
        const phase = participantPhase(state, ids[i]!, running);
        if (phase === "thinking") { seen.thinking++; expect(card, msg).not.toContain('data-tone="info"'); expect(card, msg).toContain('class="avatar avatar--active" data-p'); expect(card, msg).toMatch(/avatar--active"[^>]*data-tone="accent"/); }
        if (phase === "agreed") expect(card, msg).toMatch(/class="avatar"[^>]*data-tone="info"/);
      }
    }
    // Generator reaches the boundaries.
    expect(seen.none).toBeGreaterThan(0);
    expect(seen.part).toBeGreaterThan(0);
    expect(seen.all).toBeGreaterThan(0);
    expect(seen.cap).toBeGreaterThan(0);
    expect(seen.dropped).toBeGreaterThan(0);
    expect(seen.answered).toBeGreaterThan(0);
    expect(seen.thinking).toBeGreaterThan(0);
    expect([...seen.statuses].sort()).toEqual(["consensus", "failed", "interrupted", "no_consensus", "running", "stopped"]);
  });
});

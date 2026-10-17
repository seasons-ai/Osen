import { describe, expect, it } from "vitest";
import { foldEvents } from "@model-council/core/protocol";
import type { SessionEvent } from "@model-council/core/protocol";
import type { DraftView } from "../../shared/bridge.ts";
import { acceptedDrafts, draftMap, draftsLoader, shouldFetchDrafts } from "./session-drafts.ts";
import type { DraftsGot } from "./session-drafts.ts";

type Body = SessionEvent extends infer E ? (E extends unknown ? Omit<E, "seq" | "ts"> : never) : never;
const fold = (bodies: Body[]) => foldEvents(bodies.map((b, i) => ({ ...b, seq: i + 1, ts: "2026-01-01T00:00:00Z" }) as SessionEvent));
const created = (drafts: boolean): Body => ({
  type: "session_created", pid: 1,
  session: {
    id: "s1", createdAt: "2026-01-01T00:00:00Z", origin: "cli", topic: "Т", templateId: null, framing: "",
    participants: [1, 2].map((i) => ({ id: `p${i}`, name: `Имя${i}`, providerId: "scripted", model: "m", role: null })),
    limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
    ...(drafts ? { drafts: { enabled: true as const, synthesizerId: "p1" } } : {}),
  },
});
const dok: Body = { type: "draft_completed", draftId: "d1", participantId: "p1", attempts: 1, durationMs: 1, usage: {}, chars: 3, sha256: "a".repeat(64), reasoning: "r" };
const v = (draftId: string, text: string): DraftView => ({ draftId, participantId: "p1", attempts: 1, chars: text.length, reasoning: "r", text, error: null });

describe("session-drafts", () => {
  it("draftMap: key is draftId, a repeat gives no duplicate, the last entry is taken", () => {
    const m = draftMap([v("d1", "a"), v("d2", "b"), v("d1", "c")]);
    expect([...m.keys()]).toEqual(["d1", "d2"]);
    expect(m.get("d1")!.text).toBe("c");
    expect(draftMap([]).size).toBe(0);
  });
  it("acceptedDrafts counts accepted slots", () => {
    expect(acceptedDrafts(fold([created(true)]))).toBe(0);
    expect(acceptedDrafts(fold([created(true), dok]))).toBe(1);
  });
  it("the bridge is needed only for a session with a phase and a known id", () => {
    expect(shouldFetchDrafts("s1", fold([created(true)]))).toBe(true);
    expect(shouldFetchDrafts("s1", fold([created(false)]))).toBe(false);
    expect(shouldFetchDrafts(undefined, fold([created(true)]))).toBe(false);
    expect(shouldFetchDrafts("s1", fold([]))).toBe(false);
  });
});

describe("draftsLoader", () => {
  const defer = () => { let ok!: (v: DraftView[]) => void, no!: (e: unknown) => void; const p = new Promise<DraftView[]>((a, b) => { ok = a; no = b; }); return { p, ok, no }; };
  const setup = (call: (id: string) => Promise<DraftView[]> | DraftView[]) => {
    const box: { got: DraftsGot } = { got: null };
    return { box, loader: draftsLoader(call, (u) => { box.got = u(box.got); }) };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("the response of the first request is not applied after the second", async () => {
    const a = defer(), b = defer();
    const q = [a, b];
    const { box, loader } = setup(() => q.shift()!.p);
    const l1 = loader.load("s1"), l2 = loader.load("s1");
    await tick();
    b.ok([v("d1", "новый")]); await l2;
    a.ok([v("d1", "старый")]); await l1;
    expect(box.got!.byId.get("d1")!.text).toBe("новый");
  });
  it("after an id change (cancel) the response of the previous session is not applied", async () => {
    const a = defer();
    const { box, loader } = setup(() => a.p);
    const l = loader.load("s1");
    await tick();
    loader.cancel();
    a.ok([v("d1", "чужой")]); await l;
    expect(box.got).toBeNull();
  });
  it("a bridge refusal keeps the previous texts and gives an error", async () => {
    let fail = false;
    const { box, loader } = setup(async () => { if (fail) throw new Error("мост упал"); return [v("d1", "текст")]; });
    await loader.load("s1");
    fail = true;
    await loader.load("s1");
    expect(box.got!.error).toBe("мост упал");
    expect(box.got!.byId.get("d1")!.text).toBe("текст");
  });
  it("a synchronous bridge exception is an error, not a crash", async () => {
    const { box, loader } = setup(() => { throw new Error("сразу"); });
    await loader.load("s1");
    expect(box.got).toMatchObject({ id: "s1", error: "сразу" });
    expect(box.got!.byId.size).toBe(0);
  });
  it("a repeated response with the same draftIds gives a map of the same size", async () => {
    const { box, loader } = setup(async () => [v("d1", "a"), v("d2", "b")]);
    await loader.load("s1");
    await loader.load("s1");
    expect(box.got!.byId.size).toBe(2);
    expect(box.got!.error).toBeNull();
  });
});

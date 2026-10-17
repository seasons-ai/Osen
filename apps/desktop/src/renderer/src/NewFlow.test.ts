import { describe, expect, it } from "vitest";
import { canLaunch, refetchOnReturn, templatesKey } from "./NewFlow.tsx";

// The catalog effect restarts when the key changes: different keys before and after the transition — the catalog is requested again.
const rerun = { sessionId: "s1" };
const editor = { id: null };
const picked = { template: null };

describe("Reliable saving of a custom template: the catalog is reread on entering the gallery", () => {
  it("retry → «To templates» (save or cancel in the setup editor): the key changes, the catalog is requested again", () => {
    const before = templatesKey({ picked: null, rerun, editor: null });
    const after = templatesKey({ picked: null, rerun: null, editor: null });
    expect(before).not.toBeNull(); // on retry the catalog is needed for the template card
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("gallery editor and session setup → gallery: the catalog is requested again", () => {
    const gallery = templatesKey({ picked: null, rerun: null, editor: null });
    expect(templatesKey({ picked: null, rerun: null, editor })).not.toBe(gallery);
    expect(templatesKey({ picked, rerun: null, editor: null })).not.toBe(gallery);
  });

  it("session setup and the editor do not load the catalog again without a retry", () => {
    expect(templatesKey({ picked, rerun: null, editor: null })).toBeNull();
    expect(templatesKey({ picked: null, rerun: null, editor })).toBeNull();
  });
});

describe("Launch waits for materials: canLaunch", () => {
  const idle = { starting: false, busy: false, previewBusy: false, urlPending: null };
  it("free — allowed; any single occupation — not allowed", () => {
    expect(canLaunch(idle)).toBe(true);
    expect(canLaunch({ ...idle, starting: true })).toBe(false);
    expect(canLaunch({ ...idle, busy: true })).toBe(false);
    expect(canLaunch({ ...idle, previewBusy: true })).toBe(false);
    expect(canLaunch({ ...idle, urlPending: "https://a.b" })).toBe(false);
  });
  it("all occupations together — not allowed", () => {
    expect(canLaunch({ starting: true, busy: true, previewBusy: true, urlPending: "u" })).toBe(false);
  });
});

describe("Returning to setup from «Settings»: refetchOnReturn", () => {
  const view = { items: [] } as never;
  const bridge = () => { const b = { calls: 0, materials() { b.calls++; return Promise.resolve(view); } }; return b; };
  it("false → true rereads materials once", async () => {
    const b = bridge();
    expect(await refetchOnReturn(false, true, b)).toBe(view);
    expect(b.calls).toBe(1);
  });
  it("true → true, true → false and the first show (true without a prior false) do not call the bridge", () => {
    const b = bridge();
    expect(refetchOnReturn(true, true, b)).toBeNull();
    expect(refetchOnReturn(true, false, b)).toBeNull();
    expect(refetchOnReturn(false, false, b)).toBeNull();
    expect(b.calls).toBe(0);
  });
});

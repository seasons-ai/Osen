import { describe, expect, it } from "vitest";
import { canLaunch, refetchOnReturn, reloadRegistryOnReturn, templatesKey } from "./NewFlow.tsx";
import { checkSetup, initialForm, reduceSetup } from "./setup.ts";
import type { ProviderOption, RegistryView } from "../../shared/setup.ts";

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

describe("Session setup survives a visit to «Settings»: Registry after «Settings»", () => {
  const prov = (id: string, available: boolean): ProviderOption =>
    ({ id, kind: "openai-http", label: id, available, reason: available ? null : "connection refused", models: ["m"], defaultModel: null, billing: "free" });
  const reg = (available: boolean, maxParticipants: number): RegistryView => ({
    providers: [prov("local", available), prov("other", true)],
    ownerWait: { minSec: 1, maxSec: 86400, defaultSec: 300 },
    defaults: { maxRounds: 3, maxParticipants, materialsChars: 60000, maxTotalTokens: null, participants: [] },
  });
  const bridge = (r: () => Promise<RegistryView>) => { const b = { calls: 0, registry() { b.calls++; return r(); } }; return b; };

  it("false → true rereads the registry once; other transitions do not call the bridge", async () => {
    const fresh = reg(true, 2);
    const b = bridge(() => Promise.resolve(fresh));
    expect(await reloadRegistryOnReturn(false, true, b)).toEqual({ registry: fresh, error: null });
    expect(b.calls).toBe(1);
    expect(reloadRegistryOnReturn(true, true, b)).toBeNull();
    expect(reloadRegistryOnReturn(true, false, b)).toBeNull();
    expect(reloadRegistryOnReturn(false, false, b)).toBeNull();
    expect(b.calls).toBe(1);
  });

  it("a failed reread gives no registry (the previous one stays) and the error text", async () => {
    const b = bridge(() => Promise.reject(new Error("registry.json is broken")));
    expect(await reloadRegistryOnReturn(false, true, b)).toEqual({ registry: null, error: "registry.json is broken" });
  });

  it("the fresh registry unblocks «Start» for a provider that became available and applies the new maxParticipants; the form is unchanged", () => {
    const old = reg(false, 3);
    const ctx = { registry: old, template: null };
    let form = initialForm(ctx, null);
    form = [
      { type: "topic", value: "Which report to prepare" },
      { type: "add" }, { type: "provider", key: 0, providerId: "local" }, { type: "model", key: 0, model: "m" },
      { type: "add" }, { type: "provider", key: 1, providerId: "other" }, { type: "model", key: 1, model: "m" },
    ].reduce((f, a) => reduceSetup(f, a as never, ctx), form);
    const typed = JSON.stringify(form);
    expect(form.participants.map((p) => p.providerId)).toEqual(["local", "other"]);
    expect(checkSetup(form, old, null, "en").canStart).toBe(false);
    expect(checkSetup(form, reg(true, 3), null, "en").canStart).toBe(true);
    const three = reduceSetup(form, { type: "add" }, { registry: reg(true, 3), template: null });
    expect(three.participants).toHaveLength(3);
    expect(checkSetup(three, reg(true, 3), null, "en").canStart).toBe(true);
    const narrowed = checkSetup(three, reg(true, 2), null, "en");
    expect(narrowed.canStart).toBe(false);
    expect(narrowed.countError).toContain("2");
    const gone = { ...reg(true, 3), providers: [prov("local", true), prov("other", false)] };
    expect(checkSetup(form, gone, null, "en").participantErrors).toEqual([null, expect.stringContaining("connection refused")]);
    expect(JSON.stringify(form)).toBe(typed);
  });
});

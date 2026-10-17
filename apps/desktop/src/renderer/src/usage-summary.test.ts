import { describe, expect, it } from "vitest";
import type { UsageSummary } from "@model-council/core/protocol";
import { periodDays, periodLabel, usageLoader } from "./usage-summary.ts";
import type { UsageGot } from "./usage-summary.ts";
import type { UsagePeriod } from "./store.ts";

const T: UsagePeriod = { mode: "today", from: "", to: "" };
const M: UsagePeriod = { mode: "month", from: "", to: "" };
const R = (from: string, to: string): UsagePeriod => ({ mode: "range", from, to });
const at = (iso: string) => new Date(iso);

describe("periodDays", () => {
  it("«Today» at the Moscow day boundary", () => {
    expect(periodDays(T, at("2026-10-08T20:59:59Z"))).toEqual({ from: "2026-10-08", to: "2026-10-08" });
    expect(periodDays(T, at("2026-10-08T21:00:00Z"))).toEqual({ from: "2026-10-09", to: "2026-10-09" });
  });
  it("«Month»: October, leap February, year boundary in Moscow time", () => {
    expect(periodDays(M, at("2026-10-09T10:00:00Z"))).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(periodDays(M, at("2028-02-10T10:00:00Z"))).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(periodDays(M, at("2026-12-31T21:00:00Z"))).toEqual({ from: "2027-01-01", to: "2027-01-31" });
  });
  it("«Range»: valid, empty date, start after end, single date", () => {
    const now = at("2026-10-09T10:00:00Z");
    expect(periodDays(R("2026-10-08", "2026-10-09"), now)).toEqual({ from: "2026-10-08", to: "2026-10-09" });
    expect(periodDays(R("", "2026-10-09"), now)).toEqual({ error: "both" });
    expect(periodDays(R("2026-10-09", ""), now)).toEqual({ error: "both" });
    expect(periodDays(R("2026-10-09", "2026-10-08"), now)).toEqual({ error: "order" });
    expect(periodDays(R("2026-10-09", "2026-10-09"), now)).toEqual({ from: "2026-10-09", to: "2026-10-09" });
  });
});

describe("periodLabel", () => {
  it("three modes", () => {
    expect(periodLabel(T, { from: "2026-10-09", to: "2026-10-09" }, "ru")).toBe("09.10.2026");
    expect(periodLabel(M, { from: "2026-10-01", to: "2026-10-31" }, "ru")).toBe("октябрь 2026");
    expect(periodLabel(M, { from: "2027-01-01", to: "2027-01-31" }, "ru")).toBe("январь 2027");
    expect(periodLabel(R("", ""), { from: "2026-10-08", to: "2026-10-09" }, "ru")).toBe("08.10.2026–09.10.2026");
  });
});

describe("usageLoader", () => {
  const sum = (from: string, to: string): UsageSummary => ({ from, to, groups: [], total: { inputTokens: null, outputTokens: null, costUsd: null, records: 0, missing: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, openCalls: 0, estimate: null }, unreadable: 0, truncated: 0, tariffs: { state: "absent", warnings: [], applied: [] } });
  const setup = () => {
    const got: UsageGot[] = [];
    const pending: { from: string; resolve(s: UsageSummary): void; reject(e: unknown): void }[] = [];
    const l = usageLoader((from, to) => new Promise((resolve, reject) => { pending.push({ from, resolve: (s) => resolve(s), reject }); void to; }), (g) => got.push(g));
    return { got, pending, l };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("stale response is not applied", async () => {
    const { got, pending, l } = setup();
    const a = l.load("2026-10-01", "2026-10-01"); await tick();
    const b = l.load("2026-10-02", "2026-10-02"); await tick();
    pending[1]!.resolve(sum("2026-10-02", "2026-10-02"));
    pending[0]!.resolve(sum("2026-10-01", "2026-10-01"));
    await Promise.all([a, b]);
    expect(got).toHaveLength(1);
    expect(got[0]?.from).toBe("2026-10-02");
  });
  it("rejection gives the error text", async () => {
    const { got, pending, l } = setup();
    const p = l.load("2026-10-01", "2026-10-02"); await tick();
    pending[0]!.reject(new Error("Неверная дата"));
    await p;
    expect(got).toEqual([{ from: "2026-10-01", to: "2026-10-02", summary: null, error: "Неверная дата" }]);
  });
  it("cancel invalidates the response", async () => {
    const { got, pending, l } = setup();
    const p = l.load("2026-10-01", "2026-10-01"); await tick();
    l.cancel();
    pending[0]!.resolve(sum("2026-10-01", "2026-10-01"));
    await p;
    expect(got).toEqual([]);
  });
});

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UrlResponse, UrlTransport } from "@model-council/core";
import { setupMain } from "../shared/messages/setup-main.ts";
import { createMaterialsDraft } from "./materials.ts";

// Own seeded generator: fast-check is not used.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "council-url-prop-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(join(root, "file.txt"), "локальный файл");

const OK = ["https://h.test/ok1", "https://h.test/ok2", "https://h.test/ok3?q=1"];
const BAD = ["https://h.test/gone1", "https://h.test/gone2?q=2"];
const tick = () => new Promise<void>((r) => setImmediate(r));

describe("Preview and start of links over one set", () => {
  it("requests go only on adding; sources equal the remaining links with current mN (300 sequences)", async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = mulberry32(seed * 7919);
      const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
      const calls = new Map<string, number>(); // how many addUrl reached the network
      const hits = new Map<string, number>();
      const transport: UrlTransport = {
        async resolve() { return [{ address: "93.184.215.14", family: 4 }]; },
        async request(url): Promise<UrlResponse> {
          hits.set(url.href, (hits.get(url.href) ?? 0) + 1);
          await tick(); // loading takes time: clear and a second addUrl have time to run between the request and the response
          const bad = url.pathname.startsWith("/gone");
          return { status: bad ? 404 : 200, headers: { "content-type": "text/plain" }, body: (async function* () { yield new TextEncoder().encode(`текст ${url.pathname}${url.search}`); })(), destroy() {} };
        },
      };
      const lim = { materialsChars: 100000, materialsIgnore: [] as string[] };
      const d = createMaterialsDraft({ limits: () => lim, transport, now: () => new Date(Date.UTC(2026, 0, 1)) });
      const add = (url: string) => { calls.set(url, (calls.get(url) ?? 0) + 1); };
      const check = (label: string) => {
        const v = d.view();
        const snap = d.snapshot();
        const expected = v.items.filter((i) => i.source !== null).map((i) => ({ id: i.id, label: i.source!.label, fetchedAt: i.source!.fetchedAt }));
        const got = snap.sources.map((s) => ({ id: s.id, label: s.host + s.pathname, fetchedAt: s.fetchedAt }));
        expect(got, `seed ${seed} ${label}: источники`).toEqual(expected);
        const ids = new Set(snap.materials.map((m) => m.id));
        for (const s of snap.sources) expect(ids.has(s.id), `seed ${seed} ${label}: id ${s.id} есть в наборе`).toBe(true);
        expect(snap.materials.map((m) => m.id), `seed ${seed} ${label}: нумерация`).toEqual(snap.materials.map((_, i) => `m${i + 1}`));
        expect(d.take().length, `seed ${seed} ${label}: take`).toBe(snap.materials.length);
        for (const [u, n] of calls) expect(hits.get(u) ?? 0, `seed ${seed} ${label}: запросы к ${u}`).toBe(n);
        for (const [u, n] of hits) expect(calls.get(u) ?? 0, `seed ${seed} ${label}: лишние запросы к ${u}`).toBe(n);
      };
      check("start"); // empty list
      const steps = 1 + Math.floor(r() * 30);
      for (let s = 0; s < steps; s++) {
        const op = pick(["ok", "ok", "fail", "same", "remove", "removeLast", "refresh", "attach", "clear", "take", "empty", "inflight"] as const);
        if (op === "ok" || op === "fail" || op === "same") {
          const url = op === "ok" ? pick(OK) : op === "fail" ? pick(BAD) : pick([...calls.keys(), ...OK]);
          const before = d.view();
          add(url);
          const v = await d.addUrl(url);
          if (url.includes("/gone")) {
            expect(v.error, `seed ${seed}: отказ с причиной`).not.toBeNull();
            expect({ ...v, error: null }, `seed ${seed}: набор после отказа`).toEqual({ ...before, error: null });
          } else {
            expect(v.error, `seed ${seed}: успех`).toBeNull();
          }
        } else if (op === "remove" || op === "removeLast") {
          const items = d.view().items;
          const links = items.filter((i) => i.source !== null);
          const target = op === "removeLast" ? links.at(-1) : items.length > 0 ? pick(items) : undefined;
          const after = d.remove(target?.id ?? "m99");
          expect(after.items.length, `seed ${seed}: удаление`).toBe(items.length - (target ? 1 : 0));
        } else if (op === "refresh") d.refresh();
        else if (op === "attach") d.attach([root]);
        else if (op === "clear") d.clear();
        else if (op === "take") d.take();
        else if (op === "empty") {
          const before = d.view();
          expect(await d.addUrl(pick(["", "  ", "\t"])), `seed ${seed}: пустая строка`).toEqual(before);
        } else {
          // session at loading time: clear (or carry) before the response discards the result; the second addUrl is rejected without a request
          const url = pick(OK);
          add(url);
          const p = d.addUrl(url);
          if (r() < 0.5) expect((await d.addUrl(pick(OK))).error, `seed ${seed}: занято`).toBe(setupMain().urlBusy);
          d.clear();
          await p;
          expect(d.view().items.filter((i) => i.source !== null), `seed ${seed}: результат отброшен`).toEqual([]);
          expect(d.snapshot().sources, `seed ${seed}: источников нет`).toEqual([]);
        }
        await tick();
        await tick(); // deferred requests (the refresh mutation) have time to reach the transport
        check(`шаг ${s} ${op}`);
      }
    }
  }, 120_000);
});

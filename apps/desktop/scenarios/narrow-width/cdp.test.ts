import { describe, it, expect, vi, afterEach } from "vitest";
import { connect } from "./cdp.ts";

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class FakeWebSocket {
  static last: FakeWebSocket;
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) { this.sent.push(data); }
  close() {}
  // Returns what the connection's callback-map lookup returned for this frame.
  deliver(frame: unknown): unknown[] {
    probe.gets = [];
    probe.delivering = true;
    try { this.onmessage!({ data: JSON.stringify(frame) }); } finally { probe.delivering = false; }
    return probe.gets;
  }
}

// Observes lookups on the connection's own Map: the first `get` while a frame is being delivered is its callback lookup.
const probe: { map?: Map<unknown, unknown>; delivering: boolean; gets: unknown[] } = { delivering: false, gets: [] };
const isFn = (v: unknown) => typeof v === "function";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function open() {
  vi.restoreAllMocks(); // the property test opens many connections: do not stack spies
  probe.map = undefined; probe.delivering = false; probe.gets = [];
  const origGet = Map.prototype.get;
  vi.spyOn(Map.prototype, "get").mockImplementation(function (this: Map<unknown, unknown>, k: unknown) {
    const r = origGet.call(this, k);
    if (probe.delivering && !probe.map) probe.map = this;
    if (probe.map && this === probe.map) probe.gets.push(r);
    return r;
  });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const cdp = await connect("ws://fake");
  return { cdp, sock: FakeWebSocket.last };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

type Tracked = { state: "pending" | "ok" | "err"; value: unknown; settles: number; id: number };
function track(p: Promise<any>, id: number): Tracked {
  const t: Tracked = { state: "pending", value: undefined, settles: 0, id };
  p.then(
    (v) => { t.state = "ok"; t.value = v; t.settles++; },
    (e) => { t.state = "err"; t.value = (e as Error).message; t.settles++; }
  );
  return t;
}
const lastId = (sock: FakeWebSocket) => JSON.parse(sock.sent[sock.sent.length - 1]!).id as number;

const JUNK_IDS = ["1", "__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];

describe("CDP response correlation", () => {
  it("resolves a registered numeric id with its result", async () => {
    const { cdp, sock } = await open();
    const a = track(cdp.send("A.m"), 0);
    expect(sock.deliver({ id: lastId(sock), result: { v: 1 } }).map(isFn)).toEqual([true]);
    await flush();
    expect(a.state).toBe("ok");
    expect(a.value).toEqual({ v: 1 });
  });

  it("rejects on an error response with `${method}: ${message}`", async () => {
    const { cdp, sock } = await open();
    const a = track(cdp.send("Page.navigate"), 0);
    sock.deliver({ id: lastId(sock), error: { message: "boom" } });
    await flush();
    expect(a.state).toBe("err");
    expect(a.value).toBe("Page.navigate: boom");
  });

  it("event frames without an id call nothing", async () => {
    const { cdp, sock } = await open();
    const a = track(cdp.send("A.m"), 0);
    expect(sock.deliver({ method: "Page.loadEventFired", params: {} })).toEqual([undefined]);
    await flush();
    expect(a.state).toBe("pending");
  });

  it("unknown numeric ids and prototype-like string ids call nothing and leave requests pending", async () => {
    const { cdp, sock } = await open();
    const a = track(cdp.send("A.m"), 0);
    const id = lastId(sock);
    expect(sock.deliver({ id: id + 100, result: {} })).toEqual([undefined]);
    for (const junk of JUNK_IDS) {
      expect(sock.deliver({ id: junk, result: {} }), junk).toEqual([undefined]);
    }
    await flush();
    expect(a.state).toBe("pending");
    expect(sock.deliver({ id, result: "real" }).map(isFn)).toEqual([true]);
    await flush();
    expect(a.state).toBe("ok");
    expect(a.value).toBe("real");
  });

  it("reordered responses settle their own promises", async () => {
    const { cdp, sock } = await open();
    const a = track(cdp.send("A.m"), 0);
    const ia = lastId(sock);
    const b = track(cdp.send("B.m"), 0);
    const ib = lastId(sock);
    sock.deliver({ id: ib, result: "B" });
    await flush();
    expect([a.state, b.state, b.value]).toEqual(["pending", "ok", "B"]);
    sock.deliver({ id: ia, result: "A" });
    await flush();
    expect([a.state, a.value]).toEqual(["ok", "A"]);
    expect(b.value).toBe("B");
  });

  it("a duplicate delivery of a consumed id is ignored", async () => {
    const { cdp, sock } = await open();
    const a = track(cdp.send("A.m"), 0);
    const id = lastId(sock);
    expect(sock.deliver({ id, result: "first" }).map(isFn)).toEqual([true]);
    await flush();
    expect(sock.deliver({ id, result: "second" })).toEqual([undefined]);
    expect(sock.deliver({ id, error: { message: "late" } })).toEqual([undefined]);
    await flush();
    expect(a.settles).toBe(1);
    expect([a.state, a.value]).toEqual(["ok", "first"]);
  });

  it("only a locally registered callback for the matching numeric id is consumed, exactly once (300 seeds)", async () => {
    for (let seed = 0; seed < 300; seed++) {
      const rnd = mulberry32(seed);
      const int = (n: number) => Math.floor(rnd() * n);
      const { cdp, sock } = await open();
      const reqs: Tracked[] = [];
      const expected: { state: Tracked["state"]; value: unknown }[] = [];
      const send = () => {
        reqs.push(track(cdp.send(`M${reqs.length}.x`), 0));
        reqs[reqs.length - 1]!.id = lastId(sock);
        expected.push({ state: "pending", value: undefined });
      };
      const pendingIdx = () => expected.flatMap((e, i) => (e.state === "pending" ? [i] : []));
      const consumedIdx = () => expected.flatMap((e, i) => (e.state !== "pending" ? [i] : []));
      const junk = () => {
        const kind = int(3);
        const frame = kind === 0 ? { id: 100000 + int(1000), result: "x" }
          : kind === 1 ? { id: JUNK_IDS[int(JUNK_IDS.length)], result: {} }
          : { method: "Page.loadEventFired", params: {} };
        expect(sock.deliver(frame), `seed ${seed} junk lookup`).toEqual([undefined]);
      };
      const resolveOne = (i: number) => {
        const lookup = (frame: unknown) => expect(sock.deliver(frame).map(isFn), `seed ${seed} pending lookup`).toEqual([true]);
        if (int(2) === 0) { lookup({ id: reqs[i]!.id, result: `r${seed}-${i}` }); expected[i] = { state: "ok", value: `r${seed}-${i}` }; }
        else { lookup({ id: reqs[i]!.id, error: { message: `e${i}` } }); expected[i] = { state: "err", value: `M${i}.x: e${i}` }; }
      };
      const check = async (label: string) => {
        await flush();
        reqs.forEach((r, i) => {
          expect([r.state, r.value], `seed ${seed} ${label} req ${i}`).toEqual([expected[i]!.state, expected[i]!.value]);
          expect(r.settles, `seed ${seed} ${label} req ${i} settles`).toBeLessThanOrEqual(1);
        });
      };

      const mode = seed % 4; // 0: junk while empty first, 1: leave all pending, 2: consume all then replay, 3: random
      if (mode === 0) { for (let k = 0; k < 6; k++) junk(); await check("empty"); }
      const n = 1 + int(5);
      for (let k = 0; k < n; k++) send();
      if (mode === 1) { for (let k = 0; k < 6; k++) junk(); await check("all-pending"); continue; }
      if (mode === 2) {
        for (let i = 0; i < n; i++) resolveOne(i);
        await check("consumed");
        for (let i = 0; i < n; i++) expect(sock.deliver({ id: reqs[i]!.id, result: "replay" }), `seed ${seed} replay lookup`).toEqual([undefined]);
        await check("replayed");
        continue;
      }
      for (let step = 0; step < 25; step++) {
        const op = int(6);
        if (op === 0) send();
        else if (op === 1 || op === 2) { const p = pendingIdx(); if (p.length) resolveOne(p[int(p.length)]!); }
        else if (op === 3) { const c = consumedIdx(); if (c.length) expect(sock.deliver({ id: reqs[c[int(c.length)]!]!.id, result: "dup" }), `seed ${seed} dup lookup`).toEqual([undefined]); }
        else junk();
        await check(`step ${step}`);
      }
    }
  });
});

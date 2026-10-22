import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { cfbStreams } from "./cfb.ts";
import { systemKind } from "./detect.ts";
import { DocError } from "./limits.ts";
import { makeCfb } from "./fixture.ts";

const code = (fn: () => unknown): string => { try { fn(); } catch (e) { return e instanceof DocError ? e.code : `other ${e}`; } return "none"; };

// The generator runs in a worker with a watchdog: a reader that loops forever fails the test instead of hanging the run.
function property(seed: number, cases: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./testdata/cfb-property-worker.ts", import.meta.url), { workerData: { seed, cases }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const dog = setTimeout(() => { void w.terminate(); reject(new Error("hang: the CFB reader did not finish in 15 s")); }, 15_000);
    w.on("message", (m: string[]) => { clearTimeout(dog); void w.terminate(); resolve(m); });
    w.on("error", (e) => { clearTimeout(dog); reject(new Error(`hang or crash: ${e}`)); });
  });
}

describe("Зашифрованные документы Office", () => {
  it("the verdict depends only on the set of stream names; damaged and looping chains are damaged and always end", async () => {
    for (const seed of [1, 2, 3]) expect(await property(seed, 40)).toEqual([]);
  }, 60_000);

  it("lists only the streams directly under the root, in any count", () => {
    expect(cfbStreams(makeCfb({ streams: [] }))).toEqual([]);
    expect(cfbStreams(makeCfb({ streams: ["WordDocument", "1Table"] })).sort()).toEqual(["1Table", "WordDocument"]);
    const many = Array.from({ length: 300 }, (_, i) => `s${i}`);
    expect(cfbStreams(makeCfb({ streams: many })).sort()).toEqual([...many].sort());
  });

  it("header failures: short, wrong signature and bad shift are unsupported; a good header over broken sectors is damaged", () => {
    expect(code(() => cfbStreams(new Uint8Array(100)))).toBe("unsupported");
    expect(code(() => cfbStreams(new Uint8Array(1024)))).toBe("unsupported");
    expect(code(() => cfbStreams(makeCfb({ streams: ["WordDocument"], shift: 10 })))).toBe("unsupported");
    expect(code(() => cfbStreams(makeCfb({ streams: ["a"], loop: true })))).toBe("damaged");
    expect(code(() => cfbStreams(makeCfb({ streams: ["a"], outside: true })))).toBe("damaged");
    expect(code(() => cfbStreams(makeCfb({ streams: ["a"] }).subarray(0, 1100)))).toBe("damaged");
  });

  it("EncryptedPackage wins over WordDocument; a CFB with neither is unsupported; RTF and others are not system files", () => {
    expect(code(() => systemKind(makeCfb({ streams: ["WordDocument", "EncryptedPackage"] })))).toBe("encrypted");
    expect(systemKind(makeCfb({ streams: ["WordDocument"] }))).toBe("doc");
    expect(code(() => systemKind(makeCfb({ streams: ["Workbook"] })))).toBe("unsupported");
    expect(systemKind(Buffer.from("{\\rtf1 x}"))).toBe("rtf");
    expect(systemKind(Buffer.from("﻿{\\rtf1 x}"))).toBe("rtf");
    expect(systemKind(Buffer.from(" {\\rtf1 x}"))).toBeUndefined();
    expect(systemKind(Buffer.from("PK\x03\x04"))).toBeUndefined();
  });
});

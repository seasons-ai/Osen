import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { makeZip, type ZipPart } from "./fixture.ts";
import { DOC_LIMITS, type DocFailure } from "./limits.ts";
import { checkZip, openZip } from "./zip.ts";

const code = (fn: () => unknown): DocFailure | undefined => {
  try { fn(); } catch (e) { return (e as { code?: DocFailure }).code; }
  return undefined;
};
const check = (bytes: Uint8Array): void => checkZip(openZip(bytes), DOC_LIMITS);
const text = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i * 7919 % 1000}`).join("\n");

// Central directory record offsets of a ZIP written by makeZip (no comment).
function records(zip: Uint8Array): number[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out: number[] = [];
  let pos = v.getUint32(zip.length - 6, true);
  for (let n = v.getUint16(zip.length - 12, true); n > 0; n--) {
    out.push(pos);
    pos += 46 + v.getUint16(pos + 28, true);
  }
  return out;
}

describe("ZIP reader", () => {
  it("parts read before checkZip count towards the unpacked size limit together", () => {
    const zip = openZip(makeZip([{ name: "a", data: "123456" }, { name: "b", data: "123456" }]), { ratio: 200, unpackedBytes: 10 });
    expect(new TextDecoder().decode(zip.read("a"))).toBe("123456");
    expect(code(() => zip.read("b"))).toBe("zip_size");
  });

  it("round-trips stored and deflated parts", () => {
    const zip = openZip(makeZip([{ name: "a.txt", data: "привет 😀", method: 0 }, { name: "b/c.txt", data: text(50) }]));
    check(makeZip([{ name: "a.txt", data: "x" }]));
    expect(new TextDecoder().decode(zip.read("a.txt"))).toBe("привет 😀");
    expect(new TextDecoder().decode(zip.read("b/c.txt"))).toBe(text(50));
    expect(code(() => zip.read("missing"))).toBe("damaged");
  });

  it("calls a file without a readable directory unsupported, not damaged", () => {
    const whole = makeZip([{ name: "a.txt", data: text(20) }]);
    expect(code(() => openZip(whole.slice(0, whole.length - 10)))).toBe("unsupported");
    expect(code(() => openZip(new TextEncoder().encode("not a zip at all, just text")))).toBe("unsupported");
    expect(code(() => openZip(makeZip([])))).toBe("unsupported");
  });

  it("calls duplicate names unsupported", () => {
    expect(code(() => openZip(makeZip([{ name: "a", data: "1" }, { name: "a", data: "2" }])))).toBe("unsupported");
  });

  it("treats a declared size lower or higher than the real one as damaged and never inflates past it", () => {
    for (const method of [0, 8] as const) {
      for (const declaredSize of [10, 5000]) {
        const zip = openZip(makeZip([{ name: "a", data: text(100), method, declaredSize }]));
        expect(code(() => zip.read("a")), `method ${method} size ${declaredSize}`).toBe("damaged");
      }
    }
  });

  it("refuses an encrypted part", () => {
    const bytes = makeZip([{ name: "a", data: "x", encrypted: true }]);
    expect(code(() => check(bytes))).toBe("encrypted");
    expect(code(() => openZip(bytes).read("a"))).toBe("encrypted");
  });

  it("refuses more than 10000 parts", () => {
    const parts: ZipPart[] = Array.from({ length: DOC_LIMITS.parts + 1 }, (_, i) => ({ name: `p${i}`, data: "x", method: 0 }));
    expect(code(() => check(makeZip(parts)))).toBe("zip_parts");
    expect(code(() => check(makeZip(parts.slice(1))))).toBeUndefined();
  });

  it("refuses a declared unpacked total above 512 MiB without real data", () => {
    const part = (name: string): ZipPart => ({ name, data: text(10), method: 0, declaredSize: 300 * 2 ** 20 });
    expect(code(() => check(makeZip([part("a"), part("b")])))).toBe("zip_size");
  });

  it("refuses a compression bomb in checkZip and in read before inflation", () => {
    const bomb = makeZip([{ name: "bomb", data: new Uint8Array(20 * 2 ** 20) }]);
    expect(bomb.length).toBeLessThan(100_000);
    expect(code(() => check(bomb))).toBe("zip_ratio");
    expect(code(() => openZip(bomb).read("bomb"))).toBe("zip_ratio");
    // The directory lies: garbage cannot inflate, so reaching inflation would say "damaged".
    const lie = makeZip([{ name: "x", data: Buffer.from("garbage!"), declaredSize: 100 * 2 ** 20 }]);
    expect(code(() => check(lie))).toBe("zip_ratio");
    expect(code(() => openZip(lie).read("x"))).toBe("zip_ratio");
  });

  it("treats an unknown method as damaged", () => {
    const zip = makeZip([{ name: "a", data: "x" }]);
    new DataView(zip.buffer, zip.byteOffset).setUint16(records(zip)[0]! + 10, 99, true);
    expect(code(() => check(zip))).toBe("damaged");
  });

  it("treats overlapping entries as damaged", () => {
    const zip = makeZip([{ name: "a", data: text(30) }, { name: "b", data: text(31) }]);
    new DataView(zip.buffer, zip.byteOffset).setUint32(records(zip)[1]! + 42, 0, true);
    expect(code(() => check(zip))).toBe("damaged");
  });

  it("treats a part whose data runs past the file as damaged", () => {
    const zip = makeZip([{ name: "a", data: deflateRawSync(text(30)), method: 0 }]);
    new DataView(zip.buffer, zip.byteOffset).setUint32(records(zip)[0]! + 20, 2 ** 20, true);
    expect(code(() => check(zip))).toBe("damaged");
  });
});

// Property "Ограниченное извлечение документов": a seeded generator, any part above the ratio is refused.
describe("ZIP ratio property", () => {
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };

  it("rejects exactly the archives with a part above ratio 200", () => {
    const next = rng(208);
    for (let c = 0; c < 200; c++) {
      const bad = c % 2 === 0;
      const count = 1 + Math.floor(next() * 5);
      const badIndex = Math.floor(next() * count);
      const parts: ZipPart[] = Array.from({ length: count }, (_, i) => {
        const data = "x".repeat(1 + Math.floor(next() * 500));
        const ratio = bad && i === badIndex ? 201 + Math.floor(next() * 100) : next() < 0.3 ? 200 : 1;
        return { name: `p${i}`, data, method: 0 as const, declaredSize: data.length * ratio };
      });
      expect(code(() => check(makeZip(parts))), `case ${c}`).toBe(bad ? "zip_ratio" : undefined);
    }
  });
});

import { describe, expect, it } from "vitest";
import { listArchive, readArchive } from "./archive.ts";
import { listArchiveEntries, readArchiveEntries } from "./archive-run.ts";
import { makeZip } from "./fixture.ts";
import { DOC_LIMITS } from "./limits.ts";
import { openZip } from "./zip.ts";

const L = DOC_LIMITS;
const ok = (r: ReturnType<typeof listArchive>) => { if (!r.ok) throw new Error(r.code); return r; };
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe("listArchive", () => {
  it("classifies file, dir, symlink and encrypted entries in central directory order", () => {
    const r = ok(listArchive(makeZip([
      { name: "a.txt", data: "hello", unixMode: 0o100644 },
      { name: "d/", data: "", method: 0 },
      { name: "link", data: "a.txt", unixMode: 0o120777 },
      { name: "secret", data: "x", encrypted: true },
    ]), L));
    expect(r.entries.map((e) => [e.name, e.kind, e.size])).toEqual([["a.txt", "file", 5], ["d/", "dir", 0], ["link", "symlink", 5], ["secret", "encrypted", 1]]);
  });

  it("collects duplicate names and keeps the first record", () => {
    const r = ok(listArchive(makeZip([{ name: "x", data: "first" }, { name: "x", data: "second!" }]), L));
    expect(r.duplicates).toEqual(["x"]);
    expect(r.entries).toEqual([{ name: "x", size: 5, kind: "file" }]);
  });

  it("openZip without the duplicates argument still throws on a duplicate name", () => {
    expect(() => openZip(makeZip([{ name: "x", data: "1" }, { name: "x", data: "2" }]))).toThrow();
  });

  it("limits the number of records including duplicates", () => {
    const many = (n: number) => makeZip(Array.from({ length: n }, (_, i) => ({ name: `f${i}`, data: "", method: 0 as const })));
    expect(listArchive(many(10_000), L).ok).toBe(true);
    expect(listArchive(many(10_001), L)).toEqual({ ok: false, code: "zip_parts" });
  });

  it("limits the declared unpacked size", () => {
    const sized = (n: number) => makeZip([{ name: "a", data: "x", method: 0, declaredSize: n }]);
    // stored entries with a declared size above the real one fail the ratio-free size sum first
    expect(listArchive(sized(512 * 2 ** 20 + 1), L)).toEqual({ ok: false, code: "zip_size" });
    expect(listArchive(sized(512 * 2 ** 20), L)).not.toEqual({ ok: false, code: "zip_size" });
  });

  it("limits the compression ratio at exactly 200", () => {
    const ratio = (n: number) => makeZip([{ name: "a", data: "abcd", method: 0, declaredSize: 4 * n }]);
    expect(listArchive(ratio(201), L)).toEqual({ ok: false, code: "zip_ratio" });
    expect(listArchive(ratio(200), L).ok).toBe(true);
  });

  it("reports a truncated archive as damaged", () => {
    const zip = makeZip([{ name: "a", data: "hello" }]);
    expect(listArchive(zip.subarray(0, zip.length - 30), L)).toEqual({ ok: false, code: "damaged" });
  });

  it("gives an entry with an unknown method its own kind and does not read it", () => {
    for (const method of [12, 14, 93]) {
      const zip = makeZip([{ name: "a.txt", data: "hello", method: 0 }, { name: "b.txt", data: "xyz", method }]);
      const r = ok(listArchive(zip, L));
      expect(r.entries.map((e) => [e.name, e.kind])).toEqual([["a.txt", "file"], ["b.txt", "method"]]);
      expect(readArchive(zip, [1], L)).toEqual({ ok: true, entries: [{ i: 1, code: "unsupported" }] });
    }
  });

  it("accepts an empty archive", () => {
    expect(listArchive(makeZip([]), L)).toEqual({ ok: true, entries: [], duplicates: [] });
  });
});

describe("readArchive", () => {
  it("returns exact bytes for stored and deflated entries and unsupported for dirs and bad indices", () => {
    const payload = Uint8Array.from({ length: 300 }, (_, i) => i % 251);
    const zip = makeZip([{ name: "s", data: payload, method: 0 }, { name: "d", data: payload }, { name: "dir/", data: "", method: 0 }]);
    const r = readArchive(zip, [0, 1, 2, 9], L);
    if (!r.ok) throw new Error(r.code);
    expect(r.entries.map((e) => ("data" in e ? [...Buffer.from(e.data, "base64")] : e.code))).toEqual([[...payload], [...payload], "unsupported", "unsupported"]);
  });
});

describe("archive-run through the extractor process", () => {
  it("lists and reads a three-entry archive", () => {
    const files = [{ name: "a.txt", data: "alpha" }, { name: "b/c.txt", data: "gamma ".repeat(50) }, { name: "d.bin", data: "x", method: 0 as const }];
    const zip = makeZip(files);
    const l = listArchiveEntries(zip);
    if (!l.ok) throw new Error(l.code);
    expect(l.entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
    const r = readArchiveEntries(zip, [0, 1, 2], l.entries.reduce((s, e) => s + e.size, 0));
    if (!r.ok) throw new Error(r.code);
    expect([0, 1, 2].map((i) => dec(r.entries.get(i) as Uint8Array))).toEqual(files.map((f) => f.data));
  }, 30_000);

  it("refuses oversized input before spawning", () => {
    expect(listArchiveEntries(new Uint8Array(11), { ...L, bytes: 10 })).toEqual({ ok: false, code: "bytes" });
    expect(readArchiveEntries(new Uint8Array(11), [0], 1, { ...L, bytes: 10 })).toEqual({ ok: false, code: "bytes" });
  });
});

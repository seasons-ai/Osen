import { describe, it, expect } from "vitest";
import { NON_PUBLIC_RANGES, isPublicAddress } from "./address.ts";

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent copy of the list from the spec: the check must not depend on the constant under test.
const EXPECTED = [
  ..."0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4".split(" ").map((c) => [c.split("/")[0]!, Number(c.split("/")[1]), "ipv4"] as const),
  ..."::/128 ::1/128 ::ffff:0:0/96 64:ff9b::/96 64:ff9b:1::/48 100::/64 2001::/23 2001:db8::/32 2002::/16 fc00::/7 fe80::/10 fec0::/10 ff00::/8".split(" ").map((c) => [c.split("/")[0]!, Number(c.split("/")[1]), "ipv6"] as const),
];

const bits = (family: string) => (family === "ipv4" ? 32 : 128);
const toBig = (a: string, family: string): bigint => {
  if (family === "ipv4") return a.split(".").reduce((n, p) => (n << 8n) | BigInt(p), 0n);
  const [h = "", t = ""] = a.split("::");
  const head = h ? h.split(":") : [];
  const tail = t ? t.split(":") : [];
  const groups = [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n);
};
const fmt = (n: bigint, family: string): string =>
  family === "ipv4"
    ? [24n, 16n, 8n, 0n].map((s) => (n >> s) & 255n).join(".")
    : Array.from({ length: 8 }, (_, i) => ((n >> BigInt((7 - i) * 16)) & 0xffffn).toString(16)).join(":");
const span = ([net, prefix, family]: (typeof EXPECTED)[number]) => {
  const size = 1n << BigInt(bits(family) - prefix);
  const first = (toBig(net, family) >> (BigInt(bits(family)) - BigInt(prefix)) << (BigInt(bits(family)) - BigInt(prefix)));
  return { first, last: first + size - 1n, size };
};
const rand = (rnd: () => number, size: bigint): bigint => {
  let n = 0n;
  for (let i = 0; i < 5; i++) n = (n << 32n) | BigInt(Math.floor(rnd() * 4294967296));
  return n % size;
};
const hex4 = (n: number) => (n >>> 16).toString(16) + ":" + (n & 0xffff).toString(16);

describe("Explicit public source: a non-public address does not pass", () => {
  const rnd = mulberry32(50);

  it("constant list matches the list in the spec", () => {
    expect(NON_PUBLIC_RANGES).toEqual(EXPECTED);
  });

  it("first, last and random addresses of each range are non-public", () => {
    for (const r of EXPECTED) {
      const { first, last, size } = span(r);
      const addrs = [first, last, ...Array.from({ length: 50 }, () => first + rand(rnd, size))];
      for (const n of addrs) expect(isPublicAddress(fmt(n, r[2])), `${r[0]}/${r[1]} ${fmt(n, r[2])}`).toBe(false);
    }
  });

  it("neighbours of IPv4 ranges are public unless they fall into another range", () => {
    const v4 = EXPECTED.filter((r) => r[2] === "ipv4");
    let checked = 0;
    for (const r of v4) {
      const { first, last } = span(r);
      for (const n of [first - 1n, last + 1n]) {
        if (n < 0n || n > 0xffffffffn || v4.some((o) => { const s = span(o); return n >= s.first && n <= s.last; })) continue;
        expect(isPublicAddress(fmt(n, "ipv4")), `${r[0]}/${r[1]} сосед ${fmt(n, "ipv4")}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("IPv4-in-IPv6 wrappers are always non-public", () => {
    for (let i = 0; i < 200; i++) {
      const n = Math.floor(rnd() * 4294967296);
      const dotted = [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
      for (const w of [`::ffff:${dotted}`, `::ffff:${hex4(n)}`, `64:ff9b::${hex4(n)}`, `2002:${hex4(n)}::1`]) expect(isPublicAddress(w), w).toBe(false);
    }
  });

  it("known public addresses pass, junk does not", () => {
    for (const a of ["8.8.8.8", "1.1.1.1", "93.184.215.14", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e"]) expect(isPublicAddress(a), a).toBe(true);
    for (const a of ["", "example.com", "1.2.3", "fe80::1%lo0", "[::1]"]) expect(isPublicAddress(a), a).toBe(false);
  });
});

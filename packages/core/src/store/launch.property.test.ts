import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createSession } from "../engine.ts";
import { readLaunchFile, writeLaunchFile } from "./launch.ts";
import type { LaunchPayload } from "./launch.ts";
import "../../scenarios/language-ru.ts";

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dir = mkdtempSync(join(tmpdir(), "launch-prop-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ALPHABET = ["a", "Z", " ", "\n", "\t", "\"", "'", "\\", "й", "Ж", "é", "漢", "😀", "{", "}", "[", "]", ",", ":", " ", "<", "&"];

function generate(seed: number): LaunchPayload {
  const rnd = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const text = (maxLen: number) => Array.from({ length: int(0, maxLen) }, () => ALPHABET[int(0, ALPHABET.length - 1)]).join("");
  const nonBlank = (maxLen: number) => `t${text(maxLen)}`;
  const n = int(2, 8);
  const materials = Array.from({ length: int(0, 4) }, (_, i) => {
    const body = i === 0 && rnd() < 0.3 ? "" : rnd() < 0.1 ? "x".repeat(200_000) : text(300);
    return { id: `m${i + 1}`, name: nonBlank(20), chars: body.length, sha256: createHash("sha256").update(body, "utf8").digest("hex"), text: body };
  });
  const workspace = Array.from({ length: int(0, 5) }, (_, i) => ({ name: `d${int(0, 3)}/`.repeat(int(0, 3)) + `f${i}.txt`, text: text(200) }));
  const session = createSession({
    topic: nonBlank(300), framing: text(50), origin: (["mcp", "cli", "desktop"] as const)[int(0, 2)]!,
    limits: { maxRounds: int(1, 9), turnTimeoutSec: int(1, 600), contextChars: int(1000, 50000), ...(materials.length ? { materialsChars: 1_000_000 } : {}) },
    participants: Array.from({ length: n }, (_, i) => ({ name: nonBlank(15) + i, providerId: "scripted", model: `m${i}`, role: rnd() < 0.5 ? null : nonBlank(10) })),
    ...(materials.length ? { materials } : {}),
    ...(workspace.length ? { workspace } : {}),
  }, { maxParticipants: 8, id: `s${seed}` });
  const scenarios = Object.fromEntries(session.participants.map((p) => [p.id, `/abs/${seed}/${p.id}-${text(5).replace(/[\n/]/g, "_")}.json`]));
  return {
    session, scenarios, deadline: new Date(Date.now() + int(60, 100_000) * 1000).toISOString(),
    ...(materials.length ? { materials } : {}), ...(workspace.length ? { workspace } : {}),
  };
}

describe("Internal start of a prepared session: round-trip property", () => {
  it("readLaunchFile(writeLaunchFile(p)) deep-equals p for 150 seeded payloads", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const p = generate(seed);
      expect(readLaunchFile(writeLaunchFile(dir, p)), `seed ${seed}`).toEqual(p);
    }
  });
});

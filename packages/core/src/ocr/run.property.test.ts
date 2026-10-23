import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeExecutable } from "../executable.testutil.ts";
import { materialsMessages } from "../messages/materials.ts";
import { orderLines, type OcrLine } from "./order.ts";
import { OCR_LIMITS, runOcrHelper, setOcrRuntime } from "./run.ts";

// Own seeded generator: fast-check is not wired in.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let dir: string;
let replyFile: string;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ocr-prop-")));
  replyFile = join(dir, "reply.json");
  // one warmed stub; each case rewrites the reply file it prints
  setOcrRuntime({ helper: writeExecutable(join(dir, "stub.sh"), `#!/bin/sh\nC=$(/bin/cat)\n/bin/cat ${replyFile}\n`) });
});
afterAll(() => { setOcrRuntime(); rmSync(dir, { recursive: true, force: true }); });

const good = (i: number) => ({ t: `line ${i}`, x: 0, y: i / 100, w: 0.5, h: 0.1 });
const BAD: unknown[] = [null, 7, "text", true, [], { x: 0 }, { t: 5 }, { t: null }];

describe("runOcrHelper image mode: any reply shape", () => {
  it("never throws, refuses invalid lines as not parsed and keeps all-valid replies", () => {
    const rnd = mulberry32(2222);
    const int = (n: number) => Math.floor(rnd() * n);
    const bad = { ok: false, code: "failed", detail: materialsMessages().docBadReply };
    for (let i = 0; i < 40; i++) {
      const kind = int(4);
      let lines: unknown;
      let expected: unknown;
      if (kind === 0) { lines = [null, 7, "x", {}, { lines: [] }][int(5)]; expected = bad; }
      else if (kind === 1) {
        const arr: unknown[] = Array.from({ length: int(4) }, (_, k) => good(k));
        arr.splice(int(arr.length + 1), 0, BAD[int(BAD.length)]);
        lines = arr; expected = bad;
      } else if (kind === 2) {
        const n = 1 + int(4);
        lines = Array.from({ length: n }, (_, k) => good(k));
        expected = { ok: true, text: orderLines(lines as OcrLine[]) };
      } else {
        lines = int(2) ? [] : [{ ...good(0), t: "  " }];
        expected = { ok: false, code: "no_text" };
      }
      writeFileSync(replyFile, JSON.stringify({ ok: true, lines }) + "\n");
      let r: unknown;
      expect(() => { r = runOcrHelper({ mode: "image", ms: 10_000, rssBytes: OCR_LIMITS.rssBytes }, Buffer.from("x")); }, JSON.stringify(lines)).not.toThrow();
      expect(r, JSON.stringify(lines)).toEqual(expected);
    }
  });
});

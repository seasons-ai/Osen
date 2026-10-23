import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "./i18n/process-language.ts";
import { collectMaterials, MaterialsError, type CollectOptions } from "./materials.ts";
import { setOcrRuntime } from "./ocr/run.ts";

const opts: CollectOptions = { materialsChars: 100_000, materialsIgnore: ["node_modules", "dist"] };
const REASON = "не удалось распознать текст изображения — ответ не разобран";
let root: string;
let stubDir: string;
let n = 0;
beforeAll(() => { stubDir = realpathSync(mkdtempSync(join(tmpdir(), "materials-ocr-reply-stubs-"))); });
afterAll(() => rmSync(stubDir, { recursive: true, force: true }));
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "materials-ocr-reply-"))); setProcessLanguage("ru"); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); setOcrRuntime(); setProcessLanguage("ru"); });

function stubHelper(reply: unknown): void {
  const f = join(stubDir, `stub-${n++}.sh`);
  writeFileSync(f, `#!/bin/sh\nC=$(/bin/cat)\nprintf '%s\\n' '${JSON.stringify(reply)}'\n`);
  chmodSync(f, 0o755);
  setOcrRuntime({ helper: f });
}
function put(rel: string, content: string | Uint8Array): string {
  const f = join(root, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, content);
  return f;
}
// header-valid PNG without pixels: enough for the stub helper
function png(): Buffer {
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from("IHDR"), u32(10), u32(10), Buffer.alloc(5)]);
}

describe.each([[[null]], [[{ x: 0 }]]])("helper reply with lines %j", (lines) => {
  it("refuses an explicit image as not parsed, not as a read failure", () => {
    stubHelper({ ok: true, lines });
    let err: unknown;
    try { collectMaterials([put("shot.png", png())], opts); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(MaterialsError);
    expect((err as MaterialsError).message).toContain(REASON);
    expect((err as MaterialsError).message).not.toContain("не удалось прочитать —");
  });

  it("skips the folder image with the same reason and keeps the README", () => {
    stubHelper({ ok: true, lines });
    put("d/README.md", "# Project\n");
    put("d/shot.png", png());
    const set = collectMaterials([join(root, "d")], opts);
    expect(set.materials.map((m) => m.name)).toEqual(["d/README.md"]);
    expect(set.skipped).toEqual([{ name: "d/shot.png", reason: REASON }]);
  });
});

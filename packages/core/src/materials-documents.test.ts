import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeDocx, makeZip, p } from "./documents/fixture.ts";
import { collectMaterials, collectSessionMaterials, MaterialsError, type CollectOptions } from "./materials.ts";

const SLOW = 20_000;
const opts: CollectOptions = { materialsChars: 10_000, materialsIgnore: ["node_modules", "dist"] };
const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "materials-docs-"))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(rel: string, content: string | Uint8Array): string {
  const f = join(root, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, content);
  return f;
}
function refusal(fn: () => unknown): MaterialsError {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(MaterialsError); return e as MaterialsError; }
  throw new Error("refusal expected");
}

const TEXT = "Первая строка\nВторая строка";
const good = (): Uint8Array => makeDocx({ body: p("Первая строка") + p("Вторая строка") });
const R = {
  bad: "документ повреждён", enc: "документ зашифрован — пароль не запрашивается", none: "в документе нет текста",
  ratio: "часть документа сжата сильнее чем в 200 раз", parts: "в документе больше 10000 частей", size: "документ распаковывается больше чем в 512 МиБ",
};
const cases: [string, Uint8Array, string][] = [
  ["damaged", makeDocx({ body: "<w:p>" }), R.bad],
  ["encrypted", makeDocx({ body: p("а"), extraParts: [{ name: "e.bin", data: "a", encrypted: true }] }), R.enc],
  ["no text", makeDocx({ body: p("") + p("   ") }), R.none],
  ["ratio", makeDocx({ body: p("а"), extraParts: [{ name: "b.bin", data: "a".repeat(1_000_000) }] }), R.ratio],
  ["parts", makeDocx({ body: p("а"), extraParts: Array.from({ length: 10_001 }, (_, i) => ({ name: `x/${i}.bin`, data: "a" })) }), R.parts],
  ["unpacked size", makeDocx({ body: p("а"), extraParts: [{ name: "l.bin", data: "a", declaredSize: 600 * 2 ** 20 }] }), R.size],
];

describe("document materials", () => {
  it("explicit DOCX and DOCM: text, extension does not matter (same text and sha256)", () => {
    const files = [put("a.docx", good()), put("b.docm", makeDocx({ body: p("Первая строка") + p("Вторая строка"), macro: true })), put("report.bin", good())];
    for (const f of files) {
      const [m] = collectMaterials([f], opts).materials;
      expect(m).toMatchObject({ chars: TEXT.length, sha256: sha(TEXT), text: TEXT });
    }
  }, SLOW);

  it("explicit refusals keep the reason and leave the file alone", () => {
    for (const [name, bytes, reason] of cases) {
      const f = put("x.docx", bytes);
      expect(refusal(() => collectMaterials([f], opts)).reasons, name).toEqual([`«${f}»: ${reason}`]);
    }
  }, 60_000);

  it("folder: bad documents are skipped with a reason, README is collected", () => {
    put("d/README.md", "читай");
    put("d/good.docx", good());
    for (const [name, bytes] of cases) put(`d/${name.replace(" ", "-")}.docx`, bytes);
    const set = collectMaterials([join(root, "d")], opts);
    expect(set.materials.map((m) => [m.name, m.text])).toEqual([["d/README.md", "читай"], ["d/good.docx", TEXT]]);
    expect(set.skipped.map((s) => s.reason).sort()).toEqual(cases.map((c) => c[2]).sort());
  }, 60_000);

  it("a plain ZIP is non-text: explicit refused as before, skipped in a folder", () => {
    const zip = makeZip([{ name: "a.txt", data: "hi" }]);
    const f = put("plain.zip", zip);
    expect(refusal(() => collectMaterials([f], opts)).reasons).toEqual([`«${f}»: нетекстовый файл (не UTF-8 или бинарные данные)`]);
    put("d/a.md", "a");
    put("d/plain.zip", zip);
    expect(collectMaterials([join(root, "d")], opts).skipped).toEqual([{ name: "d/plain.zip", reason: "нетекстовый файл" }]);
  }, SLOW);

  it("folder over the limit: .docx is a description", () => {
    put("d/README.md", "r".repeat(10));
    put("d/spec.docx", makeDocx({ body: p("Первая строка") }));
    put("d/code.ts", "c".repeat(50));
    const r = collectSessionMaterials([join(root, "d")], { ...opts, materialsChars: 40 });
    expect(r.materials.map((m) => m.name)).toEqual(["d/README.md", "d/spec.docx"]);
    expect(r.left.map((l) => l.name)).toEqual(["d/code.ts"]);
  }, SLOW);
});

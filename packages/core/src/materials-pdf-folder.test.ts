import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProcessLanguage } from "./i18n/process-language.ts";
import { collectMaterials, compare, type CollectOptions } from "./materials.ts";
import { setOcrRuntime, type OcrPdfRequest, type OcrPdfResult } from "./ocr/run.ts";
import { PDF_OCR_LIMITS, setPdfOcrTesting } from "./pdf/extract.ts";
import { makePdf } from "./pdf/fixture.ts";

const SLOW = 120_000;
const opts: CollectOptions = { materialsChars: 100_000, materialsIgnore: [] };
const REASON_EN = "PDF text recognition in the folder took longer than 300 seconds — the remaining scanned PDFs were skipped";
const REASON_RU = "распознавание PDF в папке дольше 300 секунд — остальные PDF со сканами пропущены";
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "materials-pdf-folder-"))); });
afterEach(() => { setPdfOcrTesting(); setOcrRuntime(); setProcessLanguage("ru"); rmSync(root, { recursive: true, force: true }); });

function put(rel: string, content: string | Uint8Array): string {
  const f = join(root, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, content);
  return f;
}
// A scan is a PDF of k blank pages: the fake runner tells scans apart by the page count.
const scan = (pages: number): Uint8Array => makePdf(Array.from({ length: pages }, () => ""));
const names = (set: { materials: { name: string }[] }) => set.materials.map((x) => x.name);
const reasonOf = (set: { skipped: { name: string; reason: string }[] }, name: string) => set.skipped.find((s) => s.name === name)?.reason;

// Fake helper and clock: a scan of k pages costs costs[k] ms of the fake clock; a request with less time left times out.
function fake(costs: Record<number, number>, folderMs: number) {
  let t = 0;
  const launched: { pages: number; ms: number }[] = [];
  setPdfOcrTesting({
    now: () => t, folderMs,
    run: (request: OcrPdfRequest): OcrPdfResult => {
      const cost = costs[request.pages.length]!;
      expect(Number.isInteger(request.ms)).toBe(true);
      launched.push({ pages: request.pages.length, ms: request.ms });
      if (cost > request.ms) { t += request.ms; return { ok: false, code: "timeout" }; }
      t += cost;
      return { ok: true, pages: request.pages.map((n) => ({ n, text: `scan ${request.pages.length}` })) };
    },
  });
  return launched;
}

describe("Общий срок распознавания PDF в папке", () => {
  it("recognizes scans in name order until the folder budget is spent", () => {
    put("docs/README.md", "readme");
    put("docs/text.pdf", makePdf(["layer"]));
    put("docs/c.pdf", scan(3));
    put("docs/a.pdf", scan(1));
    put("docs/b.pdf", scan(2));
    const launched = fake({ 1: 100, 2: 100, 3: 100 }, 100);
    const set = collectMaterials([join(root, "docs")], opts);
    expect(names(set).sort()).toEqual(["docs/README.md", "docs/a.pdf", "docs/text.pdf"]);
    expect(reasonOf(set, "docs/b.pdf")).toBe(REASON_RU);
    expect(reasonOf(set, "docs/c.pdf")).toBe(REASON_RU);
    expect(launched.map((l) => l.pages)).toEqual([1]);
  }, SLOW);

  it("gives a scan stopped by the folder budget the folder reason, not the per-file one", () => {
    put("docs/a.pdf", scan(1));
    put("docs/b.pdf", scan(2));
    const launched = fake({ 1: 40, 2: 100 }, 100);
    const set = collectMaterials([join(root, "docs")], opts);
    expect(names(set)).toEqual(["docs/a.pdf"]);
    expect(launched[1]!.ms).toBe(60);
    expect(reasonOf(set, "docs/b.pdf")).toBe(REASON_RU);
  }, SLOW);

  it("keeps the per-file limit for a scan that exceeds it with budget to spare", () => {
    put("docs/a.pdf", scan(1));
    fake({ 1: PDF_OCR_LIMITS.ms + 1 }, 10 * PDF_OCR_LIMITS.ms);
    const set = collectMaterials([join(root, "docs")], opts);
    expect(reasonOf(set, "docs/a.pdf")).toBe("распознавание текста PDF дольше 300 секунд");
  }, SLOW);

  it("recognizes an explicit scan outside the exhausted folder", () => {
    put("docs/a.pdf", scan(1));
    put("docs/b.pdf", scan(2));
    const outside = put("outside.pdf", scan(3));
    const launched = fake({ 1: 100, 2: 100, 3: 100 }, 100);
    const set = collectMaterials([join(root, "docs"), outside], opts);
    expect(names(set).sort()).toEqual(["docs/a.pdf", "outside.pdf"]);
    expect(reasonOf(set, "docs/b.pdf")).toBe(REASON_RU);
    expect(launched.map((l) => l.pages)).toEqual([1, 3]);
  }, SLOW);

  it("reads an explicit scan skipped by the folder budget as a material and keeps the folder record", () => {
    put("docs/a.pdf", scan(1));
    const b = put("docs/b.pdf", scan(2));
    fake({ 1: 100, 2: 100 }, 100);
    const set = collectMaterials([join(root, "docs"), b], opts);
    expect(reasonOf(set, "docs/b.pdf")).toBe(REASON_RU);
    expect(names(set)).toContain("b.pdf");
    expect(names(set)).toContain("docs/a.pdf");
  }, SLOW);

  it("words the reason in English and Russian", () => {
    put("docs/a.pdf", scan(1));
    fake({ 1: 10 }, 0);
    setProcessLanguage("en");
    expect(reasonOf(collectMaterials([join(root, "docs")], opts), "docs/a.pdf")).toBe(REASON_EN);
    setProcessLanguage("ru");
    expect(reasonOf(collectMaterials([join(root, "docs")], opts), "docs/a.pdf")).toBe(REASON_RU);
  }, SLOW);

  it("stops a real helper process at the folder budget", () => {
    put("docs/a.pdf", scan(1));
    const stub = put("stub.sh", "#!/bin/sh\nexec sleep 3\n");
    chmodSync(stub, 0o755);
    setOcrRuntime({ helper: stub });
    setPdfOcrTesting({ folderMs: 500 });
    const set = collectMaterials([join(root, "docs")], opts);
    expect(reasonOf(set, "docs/a.pdf")).toBe(REASON_RU);
  }, SLOW);

  const NO_HELPER_RU = "распознавание текста недоступно — нет помощника osen-ocr";

  it("reads text-layer pages without a helper and refuses a PDF with no text-layer page", () => {
    put("docs/note.txt", "note");
    put("docs/blank.pdf", makePdf(["", ""]));
    const explicitBlank = put("blank2.pdf", makePdf(["", ""]));
    const mixed = put("docs/mixed.pdf", makePdf(["first page", ""]));
    setOcrRuntime({ helper: join(root, "absent-osen-ocr") });
    const set = collectMaterials([join(root, "docs")], opts);
    expect(names(set).sort()).toEqual(["docs/mixed.pdf", "docs/note.txt"]);
    expect(set.materials.find((x) => x.name === "docs/mixed.pdf")!.text).toContain("first page");
    expect(reasonOf(set, "docs/blank.pdf")).toBe(NO_HELPER_RU);
    let error: unknown;
    try { collectMaterials([explicitBlank], opts); } catch (e) { error = e; }
    expect((error as { reasons: string[] }).reasons).toEqual([`«${explicitBlank}»: ${NO_HELPER_RU}`]);
    const one = collectMaterials([mixed], opts);
    expect(one.materials[0]!.text).toContain("first page");
  }, SLOW);

  it("gives each attached folder its own budget", () => {
    put("d1/a.pdf", scan(1));
    put("d2/b.pdf", scan(2));
    const launched = fake({ 1: 100, 2: 100 }, 100);
    const set = collectMaterials([join(root, "d1"), join(root, "d2")], opts);
    expect(names(set).sort()).toEqual(["d1/a.pdf", "d2/b.pdf"]);
    expect(launched.length).toBe(2);
  }, SLOW);

  it("spends no budget on a result the process already remembers", () => {
    put("docs/a.pdf", scan(1));
    fake({ 1: 30, 2: 30 }, 1000);
    expect(names(collectMaterials([join(root, "docs")], opts))).toEqual(["docs/a.pdf"]);
    put("docs/b.pdf", scan(2));
    const launched = fake({ 1: 30, 2: 30 }, 30);
    const set = collectMaterials([join(root, "docs")], opts);
    expect(names(set).sort()).toEqual(["docs/a.pdf", "docs/b.pdf"]);
    expect(launched.map((l) => l.pages)).toEqual([2]);
  }, SLOW);

  it("recognizes several scans of a folder with a real helper process after the budget became fractional", () => {
    put("docs/a.pdf", scan(1));
    put("docs/b.pdf", scan(1));
    put("docs/c.pdf", scan(1));
    const stub = put("quick.sh", `#!/bin/sh\n/bin/cat > /dev/null\nprintf '{"ok":true,"pages":[{"n":1,"lines":[{"t":"scanned","x":0,"y":0,"w":1,"h":1}]}]}\\n'\n`);
    chmodSync(stub, 0o755);
    setOcrRuntime({ helper: stub });
    const set = collectMaterials([join(root, "docs")], opts);
    expect(names(set).sort()).toEqual(["docs/a.pdf", "docs/b.pdf", "docs/c.pdf"]);
  }, SLOW);

  // Own seeded generator: fast-check is not wired in.
  function mulberry32(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("matches the model of name order over random folders, costs and budgets", () => {
    const alphabet = ["a", "b", "B", "z", "Z", "я", "Я", "б", "1", "2", "10", " ", "_"];
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = mulberry32(seed);
      const int = (n: number) => Math.floor(rnd() * n);
      const dir = `case${seed}`;
      const used = new Set<string>();
      const fresh = (): string => {
        for (;;) {
          const base = Array.from({ length: 1 + int(3) }, () => alphabet[int(alphabet.length)]).join("").trim() || "x";
          if (!used.has(base.toLowerCase())) { used.add(base.toLowerCase()); return `${base}.pdf`; }
        }
      };
      const scanCount = 1 + int(5);
      const textCount = int(3);
      const files: { name: string; kind: "scan" | "text"; pages: number }[] = [];
      for (let i = 1; i <= scanCount; i++) files.push({ name: fresh(), kind: "scan", pages: i });
      for (let i = 0; i < textCount; i++) files.push({ name: fresh(), kind: "text", pages: 0 });
      for (let i = files.length - 1; i > 0; i--) { const j = int(i + 1); [files[i], files[j]] = [files[j]!, files[i]!]; }
      const costs: Record<number, number> = {};
      for (let i = 1; i <= scanCount; i++) costs[i] = 1 + int(50);
      for (const f of files) put(`${dir}/${f.name}`, f.kind === "scan" ? scan(f.pages) : makePdf([`text ${f.name}`]));

      const order = files.filter((f) => f.kind === "scan").sort((a, b) => compare(a.name, b.name));
      const total = order.reduce((s, f) => s + costs[f.pages]!, 0);
      const mode = int(4);
      let boundary = 0;
      const cut = int(order.length + 1);
      for (const f of order.slice(0, cut)) boundary += costs[f.pages]!;
      const budget = mode === 0 ? 0 : mode === 1 ? boundary : mode === 2 ? total + 1 + int(10) : 1 + int(total);

      const launched = fake(costs, budget);
      let left = budget;
      const accepted: string[] = [];
      const skipped: string[] = [];
      let modelLaunches = 0;
      for (const f of order) {
        if (left <= 0) { skipped.push(f.name); continue; }
        modelLaunches++;
        if (costs[f.pages]! <= left) { left -= costs[f.pages]!; accepted.push(f.name); } else { left = 0; skipped.push(f.name); }
      }
      const set = collectMaterials([join(root, dir)], opts);
      const got = (list: string[]) => list.map((n) => n.slice(dir.length + 1)).sort();
      const label = `seed ${seed}, budget ${budget}`;
      expect(got(names(set).filter((n) => files.find((f) => `${dir}/${f.name}` === n)!.kind === "scan")), label).toEqual([...accepted].sort());
      expect(got(set.skipped.map((s) => s.name)), label).toEqual([...skipped].sort());
      for (const s of set.skipped) expect(s.reason, label).toBe(REASON_RU);
      expect(names(set).filter((n) => files.find((f) => `${dir}/${f.name}` === n)!.kind === "text").length, label).toBe(textCount);
      expect(launched.length, label).toBe(modelLaunches);
    }
  }, SLOW);
});

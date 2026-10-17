import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProcessLanguage } from "@model-council/core/i18n";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger, UrlResponse, UrlTransport } from "@model-council/core";
import { createMaterialsDraft } from "./materials.ts";
import { PreviewError, previewMaterials } from "./materials-preview.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "council-preview-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const put = (path: string, text: string | Buffer) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
};
const SECRET = "КОНТРОЛЬНЫЙ-СЕКРЕТ-5521";
const OLD = "PREVIEW_OLD";
const BIG = "BIGSRC-" + "x".repeat(400);

let dataDir: string, src: string;
const lines: string[] = [];
const logger: Logger = { info: (m) => { lines.push(m); }, error: (m) => { lines.push(String(m)); } };
beforeEach(() => {
  const base = join(root, `t${++n}`);
  dataDir = join(base, "data");
  src = join(base, "proj");
  lines.length = 0;
  mkdirSync(dataDir, { recursive: true });
  put(join(src, "README.md"), `# ${OLD}`);
  put(join(src, "src/a.ts"), BIG);
  put(join(src, "logo.png"), Buffer.from([0, 1, 2, 0, 255, 0, 3]));
  put(join(src, ".env"), `KEY=${SECRET}`);
});
const mk = (limit = 60) => {
  const d = createMaterialsDraft({ limits: () => ({ materialsChars: limit, materialsIgnore: [] }) });
  return { d, deps: { dataDir, logger, materials: d } };
};
const linkTransport = (text: () => string) => {
  const t = { requests: 0, transport: undefined as unknown as UrlTransport };
  t.transport = {
    async resolve() { return [{ address: "93.184.215.14", family: 4 }]; },
    async request(): Promise<UrlResponse> {
      t.requests++;
      const body = text();
      return { status: 200, headers: { "content-type": "text/plain" }, body: (async function* () { yield new TextEncoder().encode(body); })(), destroy() {} };
    },
  };
  return t;
};
const sets = () => (existsSync(join(dataDir, "prepared-materials")) ? readdirSync(join(dataDir, "prepared-materials")) : []);

describe("previewMaterials", () => {
  it("section texts, available files, skipped ones; without secrets, extra texts and paths", () => {
    const { d, deps } = mk();
    d.attach([src]);
    const r = previewMaterials(deps, false);
    expect(r.initial).toContain(`# ${OLD}`);
    const readme = r.available.find((a) => a.name.endsWith("README.md"))!;
    const big = r.available.find((a) => a.name.endsWith("src/a.ts"))!;
    expect(readme.initial).toBe(true);
    expect(big.initial).toBe(false);
    expect(big.reason).toBeTruthy();
    const sk = r.skipped.map((s) => s.name);
    expect(sk.some((x) => x.endsWith(".env"))).toBe(true);
    expect(sk.some((x) => x.endsWith("logo.png"))).toBe(true);
    expect(r.skipped.every((s) => s.reason !== "")).toBe(true);
    const all = JSON.stringify(r);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(BIG);
    expect(all).not.toContain(root);
    expect(r.stamp).toBe(d.stamp());
    expect(r.materials).toEqual(d.view());
    const log = lines.join("\n");
    expect(log).toContain(`Materials preview: set ${r.handle}`);
    for (const bad of [SECRET, "README", "a.ts", ".env", root, OLD]) expect(log).not.toContain(bad);
  });

  it("a set on disk, no sessions", () => {
    const { d, deps } = mk();
    d.attach([src]);
    const r = previewMaterials(deps, false);
    expect(existsSync(join(dataDir, "prepared-materials", r.handle, "set.json"))).toBe(true);
    expect(existsSync(join(dataDir, "sessions"))).toBe(false);
  });

  it("two calls: different handles, the first set did not change", () => {
    const { d, deps } = mk();
    d.attach([src]);
    const a = previewMaterials(deps, false);
    const path = join(dataDir, "prepared-materials", a.handle, "set.json");
    const bytes = readFileSync(path);
    const b = previewMaterials(deps, false);
    expect(b.handle).not.toBe(a.handle);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it("refresh picks up a source change", () => {
    const { d, deps } = mk();
    d.attach([src]);
    writeFileSync(join(src, "README.md"), "# PREVIEW_NEW");
    const r = previewMaterials(deps, true);
    expect(r.initial).toContain("PREVIEW_NEW");
    expect(lines.join("\n")).toContain("sources re-read");
  });

  it("refresh with a deleted root: PreviewError, no new sets, the draft unchanged", () => {
    const { d, deps } = mk();
    d.attach([src]);
    const first = previewMaterials(deps, false);
    const before = d.view();
    rmSync(src, { recursive: true });
    expect(() => previewMaterials(deps, true)).toThrow(PreviewError);
    expect(sets()).toEqual([first.handle]);
    expect(d.view()).toEqual(before);
  });

  it("empty draft: PreviewError", () => {
    const { deps } = mk();
    expect(() => previewMaterials(deps, false)).toThrow(PreviewError);
    expect(sets()).toEqual([]);
  });

  it("limit exceeded by explicit files: PreviewError with a reason, nothing written to disk", () => {
    const f = put(join(root, `big${n}.txt`), "y".repeat(500));
    const { d, deps } = mk(100);
    d.attach([f]);
    expect(() => previewMaterials(deps, false)).toThrow(PreviewError);
    expect(() => previewMaterials(deps, false)).toThrow(/\S/);
    expect(sets()).toEqual([]);
  });

  it("write error: PreviewError with a code, an error goes to the journal", () => {
    const { d, deps } = mk();
    d.attach([src]);
    const err = vi.fn();
    const save = () => { throw Object.assign(new Error("x"), { code: "EACCES" }); };
    expect(() => previewMaterials({ ...deps, logger: { info: vi.fn(), error: err }, save }, false)).toThrow("Не удалось сохранить подготовленный набор: EACCES");
    expect(err).toHaveBeenCalled();
  });
});

describe("preview: excluded by rules", () => {
  it("excluded by rules is not in the preview skipped but in materials.ignored; after including the file is available, the set keeps excludedPath", () => {
    put(join(src, ".gitignore"), "out/\n");
    put(join(src, "out/main.js"), "собранный");
    const { d, deps } = mk(100000);
    d.attach([src]);
    const r = previewMaterials(deps, false);
    expect(r.skipped.map((s) => s.name)).not.toContain("proj/out/");
    expect(r.materials.ignored).toEqual([{ id: "x1", name: "proj/out/", rule: "out/", returned: false }]);
    expect(r.available.map((a) => a.name)).not.toContain("proj/out/main.js");
    const saved = JSON.parse(readFileSync(join(dataDir, "prepared-materials", sets()[0]!, readdirSync(join(dataDir, "prepared-materials", sets()[0]!))[0]!), "utf8").toString());
    expect(JSON.stringify(saved)).toContain("excludedPath");
    d.returnIgnored("x1");
    expect(previewMaterials(deps, false).available.map((a) => a.name)).toContain("proj/out/main.js");
  });
});

describe("preview: language", () => {
  afterEach(() => setProcessLanguage("ru"));
  const cyr = /[А-Яа-яЁё]/;

  it("nothing to show: en, then ru on one draft, the set is not created", () => {
    const { deps } = mk();
    setProcessLanguage("en");
    expect(() => previewMaterials(deps, false)).toThrow(new PreviewError("No materials attached: nothing to show"));
    setProcessLanguage("ru");
    expect(() => previewMaterials(deps, false)).toThrow(new PreviewError("Материалы не приложены: показывать нечего"));
    expect(sets()).toEqual([]);
  });

  it("write failure: en and ru, with a code and without", () => {
    const { d, deps } = mk();
    d.attach([src]);
    const withCode = () => { throw Object.assign(new Error("x"), { code: "EACCES" }); };
    const noCode = () => { throw new Error("x"); };
    const call = (save: () => never) => () => previewMaterials({ ...deps, logger: { info: vi.fn(), error: vi.fn() }, save }, false);
    setProcessLanguage("en");
    expect(call(withCode)).toThrow(new PreviewError("Could not save the prepared set: EACCES"));
    expect(call(noCode)).toThrow(new PreviewError("Could not save the prepared set: write error"));
    setProcessLanguage("ru");
    expect(call(withCode)).toThrow(new PreviewError("Не удалось сохранить подготовленный набор: EACCES"));
    expect(call(noCode)).toThrow(new PreviewError("Не удалось сохранить подготовленный набор: ошибка записи"));
    expect(sets()).toEqual([]);
  });

  it("skipped and not included from the core: in the preview verbatim, as in the draft view, at en and ru", () => {
    for (const lang of ["en", "ru"] as const) {
      setProcessLanguage(lang);
      const { d, deps } = mk();
      const v = d.attach([src]);
      const r = previewMaterials(deps, false);
      expect(r.skipped.length).toBeGreaterThan(0);
      expect(r.skipped.map((s) => s.reason)).toEqual(v.skipped.map((s) => s.reason));
      if (lang === "en") expect(JSON.stringify(r.skipped)).not.toMatch(cyr);
      const big = r.available.find((a) => a.name.endsWith("src/a.ts"))!;
      expect(big.reason).toBe(v.left.find((l) => l.name.endsWith("src/a.ts"))!.reason);
    }
  });
});

describe("previewMaterials: links", () => {
  it("link preview: text in initial, the source in sources, the \"Link sources\" section", async () => {
    const t = linkTransport(() => "ТЕКСТ-ИЗ-ССЫЛКИ");
    const d = createMaterialsDraft({ limits: () => ({ materialsChars: 1000, materialsIgnore: [] }), transport: t.transport });
    await d.addUrl("https://example.org/doc?token=SECRET");
    const r = previewMaterials({ dataDir, logger, materials: d }, false);
    expect(r.initial).toContain("ТЕКСТ-ИЗ-ССЫЛКИ");
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0]!.url).toBe("https://example.org/doc");
    expect(r.sources[0]!.fetchedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(t.requests).toBe(1);
  });
});

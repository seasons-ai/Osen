import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setProcessLanguage } from "./i18n/process-language.ts";
import type { Language } from "./i18n/language.ts";
import { MaterialsError, collectMaterials, selectMaterials, verifyMaterials } from "./materials.ts";
import { PDF_LIMITS, pdfReason } from "./pdf/extract.ts";
import type { PdfFailure } from "./pdf/extract.ts";
import { collectUrlMaterials } from "./url/collect.ts";
import { extractUrlText, UrlTextError } from "./url/extract.ts";
import { fetchUrl, UrlFetchError } from "./url/fetch.ts";
import type { UrlResponse, UrlTransport } from "./url/fetch.ts";

const CYR = /[Ѐ-ӿ]/;
const nums = (s: string) => s.match(/\d+(\.\d+)?/g) ?? [];
const as = async <T>(lang: Language, f: () => T | Promise<T>): Promise<T> => {
  setProcessLanguage(lang);
  return await f();
};

describe("Core messages in the selected language: materials, PDF, links", () => {
  afterEach(() => setProcessLanguage("ru"));

  it("each kind of PDF refusal: same numbers and limits in both languages", () => {
    const codes: PdfFailure[] = ["bytes", "pages", "chars", "timeout", "memory", "encrypted", "damaged", "no_text", "failed",
      "ocr_pages", "ocr_missing", "ocr_start", "ocr_page_timeout", "ocr_timeout", "ocr_memory", "ocr_failed"];
    for (const code of codes) {
      setProcessLanguage("en");
      const en = pdfReason({ code, detail: "exit 3" });
      setProcessLanguage("ru");
      const ru = pdfReason({ code, detail: "exit 3" });
      expect(en, code).not.toMatch(CYR);
      expect(ru, code).toMatch(CYR);
      expect(nums(en), code).toEqual(nums(ru));
    }
    setProcessLanguage("en");
    expect(pdfReason({ code: "pages" })).toBe(`PDF has more than ${PDF_LIMITS.pages} pages`);
    expect(pdfReason({ code: "chars" }, { ...PDF_LIMITS, chars: 1 })).toBe("PDF text is longer than 1 character");
    setProcessLanguage("ru");
    expect(pdfReason({ code: "bytes" })).toBe("PDF больше 100 МиБ");
    expect(pdfReason({ code: "chars" })).toBe("текст PDF больше 20000000 знаков");
  });

  describe("links", () => {
    const PUB = { address: "93.184.215.14", family: 4 as const };
    const PRIV = { address: "10.0.0.1", family: 4 as const };
    type Reply = { status?: number; headers?: Record<string, string>; body?: string };
    const transport = (handler: (u: URL) => Reply | "private"): UrlTransport => ({
      async resolve(h) {
        if (h === "nx.test") throw new Error("ENOTFOUND");
        return [h === "private.test" ? PRIV : PUB];
      },
      async request(url): Promise<UrlResponse> {
        const r = handler(url) as Reply;
        const body = (async function* () { yield new TextEncoder().encode(r.body ?? "hi"); })();
        return { status: r.status ?? 200, headers: { "content-type": "text/plain", ...r.headers }, body, destroy() {} };
      },
    });
    const limits = { ms: 200, bytes: 5, redirects: 2 };
    // address, response, expected reason code
    const cases: [string, (u: URL) => Reply, string][] = [
      ["http://[bad", () => ({}), "invalid"],
      ["ftp://h.test/a", () => ({}), "scheme"],
      ["https://user:pw@h.test/a", () => ({}), "credentials"],
      ["https://nx.test/a", () => ({}), "dns"],
      ["https://private.test/a", () => ({}), "private"],
      ["https://h.test/r", () => ({ status: 302, headers: { location: "https://private.test/x" } }), "private"],
      ["https://h.test/r", () => ({ status: 302 }), "redirect"],
      ["https://h.test/r", () => ({ status: 302, headers: { location: "/r" } }), "redirects"],
      ["https://h.test/a", () => ({ status: 404 }), "status"],
      ["https://h.test/a", () => ({ headers: { "content-encoding": "gzip" } }), "encoding"],
      ["https://h.test/a", () => ({ headers: { "content-type": "application/pdf" } }), "type"],
      ["https://h.test/a", () => ({ headers: { "content-type": "" } }), "type"],
      ["https://h.test/a", () => ({ body: "0123456789" }), "size"],
    ];

    it("UrlFetchError: one code, text in the process language, same numbers and addresses", async () => {
      for (const [raw, handler, code] of cases) {
        const get = (lang: Language) => as(lang, () => fetchUrl(raw, { transport: transport(handler), limits }).then(() => null, (e: unknown) => e as UrlFetchError));
        const en = await get("en");
        const ru = await get("ru");
        expect(en, raw).toBeInstanceOf(UrlFetchError);
        expect(en!.code, raw).toBe(code);
        expect(ru!.code, raw).toBe(code);
        expect(en!.message).toBe(en!.reason);
        expect(en!.reason, raw).not.toMatch(CYR);
        expect(ru!.reason, raw).toMatch(CYR);
        expect(nums(en!.reason), raw).toEqual(nums(ru!.reason));
      }
    });

    it("network error and timeout", async () => {
      const slow: UrlTransport = { resolve: async () => [PUB], request: () => new Promise(() => {}) };
      const broken: UrlTransport = { resolve: async () => [PUB], request: async () => { throw Object.assign(new Error("x"), { code: "ECONNRESET" }); } };
      expect((await as("en", () => fetchUrl("https://h.test/", { transport: slow, limits: { ms: 50 } }).catch((e: UrlFetchError) => e) as Promise<UrlFetchError>)).reason).toBe("did not finish within 0.05 seconds");
      expect((await as("en", () => fetchUrl("https://h.test/", { transport: broken }).catch((e: UrlFetchError) => e) as Promise<UrlFetchError>)).reason).toBe("network error — ECONNRESET");
      expect((await as("ru", () => fetchUrl("https://h.test/", { transport: broken }).catch((e: UrlFetchError) => e) as Promise<UrlFetchError>)).reason).toBe("сетевая ошибка — ECONNRESET");
    });

    it("UrlTextError: same codes, text by language", async () => {
      const bytes = (s: string) => new Uint8Array(Buffer.from(s));
      const run = (lang: Language, input: Parameters<typeof extractUrlText>[0]) =>
        as(lang, () => extractUrlText(input).then(() => null, (e: unknown) => e as UrlTextError));
      const inputs = [
        { bytes: bytes("x"), contentType: "text/plain" as const, charset: "koi8-r" },
        { bytes: new Uint8Array([0xff, 0xfe, 0x00]), contentType: "text/plain" as const },
        { bytes: bytes("   "), contentType: "text/plain" as const },
      ];
      for (const input of inputs) {
        const en = await run("en", input);
        const ru = await run("ru", input);
        expect(en!.code).toBe(ru!.code);
        expect(en!.reason).not.toMatch(CYR);
        expect(ru!.reason).toMatch(CYR);
      }
      expect((await run("en", inputs[0]!))!.reason).toBe("encoding koi8-r is not supported — UTF-8 is required");
      expect((await run("ru", inputs[0]!))!.reason).toBe("кодировка koi8-r не поддерживается — нужен UTF-8");
    });

    it("safe address form: without query and credentials, also in en, with a number for a non-address", async () => {
      setProcessLanguage("en");
      const q = "?token=SECRETMARK#SECRETMARK";
      const t = transport((u) => (u.pathname === "/404" ? { status: 404 } : u.pathname === "/pdf" ? { headers: { "content-type": "application/pdf" } } : { body: "0123456789" }));
      const urls = ["404", "pdf", "big"].map((p) => `https://h.test/${p}${q}`).concat(`https://private.test/x${q}`, `https://user:SECRETMARK@h.test/x`);
      const e = (await collectUrlMaterials(urls, { transport: t, limits }).catch((x: unknown) => x)) as MaterialsError;
      expect(e.reasons).toHaveLength(5);
      expect(e.message + e.reasons.join("")).not.toContain("SECRETMARK");
      expect(e.reasons.join("")).not.toMatch(CYR);
      const bad = (await collectUrlMaterials(["", "https://h.test/a"], { transport: t, limits: { ...limits, bytes: 1000 } }).catch((x: unknown) => x)) as MaterialsError;
      expect(bad.reasons).toEqual(["«URL #1»: could not parse the address"]);
    });
  });

  describe("materials", () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
    const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "mat-lang-"))); dirs.push(d); return d; };
    const opts = { materialsChars: 1_000_000, materialsIgnore: ["skipme"] };
    const err = (paths: string[]) => { try { collectMaterials(paths, opts); } catch (e) { return e as MaterialsError; } throw new Error("no error"); };

    it("MaterialsError: explicit path refusals in both languages, path name not translated", () => {
      const d = tmp();
      writeFileSync(join(d, ".env"), "K=1");
      writeFileSync(join(d, "bin.dat"), Buffer.from([0, 1, 2, 0xff]));
      const paths = [join(d, "нет-файла.txt"), join(d, ".env"), join(d, "bin.dat")];
      setProcessLanguage("en");
      const en = err(paths).reasons;
      setProcessLanguage("ru");
      const ru = err(paths).reasons;
      expect(en).toEqual([
        `«${paths[0]}»: path not found`,
        `«${paths[1]}»: environment files (.env, .env.*) cannot be attached — secrets protection`,
        `«${paths[2]}»: binary file of an unknown format`,
      ]);
      expect(ru).toEqual([
        `«${paths[0]}»: путь не найден`,
        `«${paths[1]}»: файлы окружения (.env, .env.*) прикладывать нельзя — защита секретов`,
        `«${paths[2]}»: двоичный файл неизвестного формата`,
      ]);
    });

    it("folder file skips (skipped) in both languages, file names not translated", () => {
      const d = tmp();
      const dir = join(d, "папка");
      mkdirSync(dir);
      for (const f of ["a.txt", ".env", ".hid", "skipme"]) writeFileSync(join(dir, f), "t");
      writeFileSync(join(dir, "b.bin"), Buffer.from([0, 1]));
      const skipped = (lang: Language) => { setProcessLanguage(lang); return collectMaterials([dir], opts).skipped; };
      expect(skipped("en")).toEqual([
        { name: "папка/.env", reason: "environment file — secrets protection" },
        { name: "папка/.hid", reason: "hidden name" },
        { name: "папка/b.bin", reason: "binary file of an unknown format" },
        { name: "папка/skipme", reason: "in the ignore list" },
      ]);
      expect(skipped("ru")).toEqual([
        { name: "папка/.env", reason: "файл окружения — защита секретов" },
        { name: "папка/.hid", reason: "скрытое имя" },
        { name: "папка/b.bin", reason: "двоичный файл неизвестного формата" },
        { name: "папка/skipme", reason: "в списке игнорирования" },
      ]);
    });

    it("limit exceeded, left and set check in both languages with the same numbers", () => {
      const mk = (name: string, n: number) => ({ id: "m1", name, chars: n, text: "x".repeat(n), sha256: "bad" });
      const d = tmp();
      writeFileSync(join(d, "a.txt"), "x".repeat(50));
      writeFileSync(join(d, "b.txt"), "y".repeat(50));
      const get = (lang: Language) => {
        setProcessLanguage(lang);
        try { collectMaterials([join(d, "a.txt"), join(d, "b.txt")], { ...opts, materialsChars: 60 }); } catch (e) { return (e as MaterialsError).reasons[0]!; }
        throw new Error("no error");
      };
      expect(get("en")).toMatch(/^Materials: size 100 characters exceeds the limit 60\. Largest files: a\.txt — 50, b\.txt — 50$/);
      expect(get("ru")).toBe("Материалы: объём 100 символов превышает лимит 60. Крупнейшие файлы: a.txt — 50, b.txt — 50");

      const src = [mk("dir/big.md", 30), { ...mk("dir/x.bin", 5), id: "m2" }];
      const left = (lang: Language) => { setProcessLanguage(lang); return selectMaterials(src, [], 10).left.map((l) => l.reason); };
      expect(left("en")).toEqual(["did not fit the limit — 30 characters", "not a description — only descriptions are taken from a folder over the limit"]);
      expect(left("ru")).toEqual(["не поместился в лимит — 30 знаков", "не описание — из папки больше лимита берутся только описания"]);

      const problems = (lang: Language) => { setProcessLanguage(lang); return verifyMaterials([{ ...mk("n", 3), id: "m9" }], undefined); };
      expect(problems("en")).toEqual(["Material 1: id «m9» instead of m1", "Material m9: checksum does not match the text", "materials limit is not set"]);
      expect(problems("ru")).toEqual(["Материал 1: идентификатор «m9» вместо m1", "Материал m9: контрольная сумма не совпадает с текстом", "лимит материалов не задан"]);
    });
  });
});

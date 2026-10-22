// @ts-expect-error: pdf.worker.mjs has no type file
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PdfResult, PdfScan } from "./extract.ts";

// PDF.js takes the "fake worker" handler from globalThis.pdfjsWorker and does not do a dynamic import.
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

export async function extractText(bytes: Uint8Array, limits: { pages: number; chars: number }): Promise<PdfResult | PdfScan> {
  const task = getDocument({
    data: bytes, enableXfa: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
    verbosity: 0, stopAtErrors: false,
  });
  try {
    const doc = await task.promise;
    if (doc.numPages > limits.pages) return { ok: false, code: "pages" };
    const parts: string[] = [];
    let length = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      let page = "";
      for (const item of content.items) if ("str" in item) page += item.str + (item.hasEOL ? "\n" : "");
      length += page.length + (n > 1 ? 2 : 0);
      if (length > limits.chars) return { ok: false, code: "chars" };
      parts.push((page.replace(/[\x00-\x08\x0e-\x1f\x7f]/g, "") as string & { toWellFormed(): string }).toWellFormed());
    }
    const blank = parts.flatMap((p, i) => (/\S/.test(p) ? [] : [i + 1]));
    if (blank.length > 0) return { ok: true, pages: doc.numPages, parts, blank };
    return { ok: true, text: parts.join("\n\n"), pages: doc.numPages };
  } catch (e) {
    return { ok: false, code: (e as { name?: string }).name === "PasswordException" ? "encrypted" : "damaged" };
  } finally {
    await task.destroy().catch(() => {});
  }
}

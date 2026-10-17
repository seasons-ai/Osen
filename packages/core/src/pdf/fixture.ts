// Test PDFs assembled by hand: no libraries and no personal data.
const hex = (n: number, w = 4): string => n.toString(16).toUpperCase().padStart(w, "0");

function assemble(objects: readonly string[], trailerExtra = "", header = "%PDF-1.7\n"): Uint8Array {
  let out = header;
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

const stream = (body: string): string => `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;

export function makePdf(pages: readonly string[], options: { link?: string; openActionJs?: string } = {}): Uint8Array {
  const codes = new Map<string, number>();
  const cmap: string[] = [];
  const show = (line: string): string => {
    let h = "";
    for (const ch of line) {
      let code = codes.get(ch);
      if (code === undefined) {
        code = codes.size + 1;
        codes.set(ch, code);
        const u = [...Buffer.from(ch, "utf16le").swap16()].map((b) => hex(b, 2)).join("");
        cmap.push(`<${hex(code, 2)}> <${u}>`);
      }
      h += hex(code, 2);
    }
    return `<${h}> Tj`;
  };
  const contents = pages.map((page) => {
    const lines = page === "" ? [] : page.split("\n");
    return lines.length === 0 ? "" : `BT /F1 12 Tf 14 TL 50 700 Td\n${lines.map(show).join("\nT*\n")}\nET`;
  });
  const cm = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n/CMapName /Adobe-Identity-UCS def /CMapType 2 def\n`
    + `1 begincodespacerange <00> <FF> endcodespacerange\n${cmap.length} beginbfchar\n${cmap.join("\n")}\nendbfchar\nendcmap end end`;
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(" ");
  const annot = options.link ? 5 + pages.length * 2 : 0;
  const widths = Array.from({ length: Math.max(codes.size, 1) }, () => 500).join(" ");
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${options.openActionJs ? ` /OpenAction << /S /JavaScript /JS (${options.openActionJs}) >>` : ""} >>`,
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 1 /LastChar ${Math.max(codes.size, 1)} /Widths [${widths}] /ToUnicode 4 0 R >>`,
    stream(cm),
    ...pages.flatMap((_, i) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${6 + i * 2} 0 R${i === 0 && annot ? ` /Annots [${annot} 0 R]` : ""} >>`,
      stream(contents[i]!),
    ]),
    ...(annot ? [`<< /Type /Annot /Subtype /Link /Rect [50 690 300 710] /Border [0 0 0] /A << /S /URI /URI (${options.link}) >> >>`] : []),
  ];
  return assemble(objects);
}

export function makeEncryptedPdf(): Uint8Array {
  const o = hex(0x41, 2).repeat(32);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    stream("0 0 1 rg 10 10 100 100 re f"),
    `<< /Filter /Standard /V 1 /R 2 /O <${o}> /U <${hex(0x42, 2).repeat(32)}> /P -4 >>`,
  ];
  return assemble(objects, ` /Encrypt 5 0 R /ID [<${"00".repeat(16)}> <${"00".repeat(16)}>]`);
}

export function makeImageOnlyPdf(): Uint8Array {
  return assemble([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    stream("0 0 1 rg 10 10 100 100 re f"),
  ]);
}

export function makeMalformedPdf(): Uint8Array {
  return new Uint8Array(Buffer.from("%PDF-1.7\nэто совсем не PDF \u0000\u0001 мусор мусор мусор\n", "utf8"));
}

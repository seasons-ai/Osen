// Live check of change 220 (real council processes, --preview-materials, 0 model calls): a PDF with only an owner password is read,
// a PDF with an open password is refused as encrypted, without the OCR helper text-layer pages are read, and scanned PDFs of one
// attached folder share a 300 s recognition budget (stub helper sleeping 200 s; takes about 9 minutes).
//   COUNCIL_DEV=1 node packages/core/scenarios/pdf-owner-folder/check.ts
// Needs `npm run build:ocr` (macOS). Creates .council-data/pdf-owner-folder-*, deletes it on success, keeps it on failure.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeOwnerPasswordPdf } from "../../src/ocr/fixture.ts";
import { makeEncryptedPdf, makePdf, makeScanPdf } from "../../src/pdf/fixture.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Run: COUNCIL_DEV=1 node packages/core/scenarios/pdf-owner-folder/check.ts");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
if (!existsSync(join(repo, "packages/core/src/ocr/bin/osen-ocr"))) {
  console.error("osen-ocr is not built — run: npm run build:ocr");
  process.exit(2);
}
const dir = join(repo, ".council-data", `pdf-owner-folder-${Date.now()}-${randomBytes(3).toString("hex")}`);
mkdirSync(join(dir, "fx"), { recursive: true });
mkdirSync(join(dir, "scans"));
const W = realpathSync(dir);
const fx = (name: string) => join(W, "fx", name);

writeFileSync(fx("owner.pdf"), makeOwnerPasswordPdf(["Text layer page one", ""]));
writeFileSync(fx("plain.pdf"), makePdf(["Text layer page one", ""]));
writeFileSync(fx("locked.pdf"), makeEncryptedPdf());
writeFileSync(fx("blank.pdf"), makePdf(["", ""]));
writeFileSync(join(W, "scans/README.md"), "# Scans\n");
writeFileSync(join(W, "scans/text.pdf"), makePdf(["Only a text layer"]));
for (const n of ["c", "a", "b"]) writeFileSync(join(W, "scans", `${n}.pdf`), makeScanPdf([[`Scan ${n.toUpperCase()}`]]));
const reply = JSON.stringify({ ok: true, pages: [{ n: 1, lines: [{ t: "stub recognized", x: 0, y: 0, w: 1, h: 1 }] }] });
for (const s of ["stub-ru.sh", "stub-en.sh"]) {
  writeFileSync(join(W, s), `#!/bin/sh\n/bin/cat > /dev/null\n/bin/sleep 200\nprintf '%s\\n' '${reply}'\n`);
  chmodSync(join(W, s), 0o755);
}

function council(args: string[], lang: string, helper?: string): Promise<{ code: number | null; out: string; seconds: number }> {
  const env: Record<string, string> = { ...process.env, COUNCIL_DEV: "1", COUNCIL_LANG: lang, COUNCIL_HOME: join(W, "home") } as Record<string, string>;
  if (helper) env.COUNCIL_OCR_HELPER = helper;
  else delete env.COUNCIL_OCR_HELPER;
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(repo, "packages/core/src/council.ts"), "--preview-materials", ...args], { env, cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out, seconds: Math.round((Date.now() - started) / 1000) }));
  });
}
const ok = (m: string) => console.log(`PASS ${m}`);
const material = (out: string, name: string, text: string) => out.includes(`: ${name}\n${text}`);

// distinct helper processes of one stub: the helper runs under sandbox-exec without file writes, so launches are counted from outside
const launches = new Map<string, Set<string>>([["stub-ru.sh", new Set()], ["stub-en.sh", new Set()]]);
const poll = setInterval(() => {
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout ?? "";
  for (const line of ps.split("\n")) for (const [stub, pids] of launches) if (line.includes(join(W, stub)) && !line.includes("sandbox-exec")) pids.add(line.trim().split(/\s+/)[0]!);
}, 1000);

try {
  let r = await council(["--attach", fx("owner.pdf")], "ru");
  const plain = await council(["--attach", fx("plain.pdf")], "ru");
  assert.equal(r.code, 0, r.out);
  assert.ok(material(r.out, "owner.pdf", "Text layer page one") && material(plain.out, "plain.pdf", "Text layer page one"), r.out + plain.out);
  ok("owner-password PDF: exit 0, «Text layer page one», same text as the PDF without a password");

  r = await council(["--attach", fx("locked.pdf")], "ru");
  assert.equal(r.code, 2, r.out);
  assert.ok(r.out.includes("«locked.pdf»: PDF зашифрован — пароль не запрашивается"), r.out);
  ok("open-password PDF: exit 2, «PDF зашифрован — пароль не запрашивается»");

  r = await council(["--attach", fx("plain.pdf")], "ru", join(W, "absent"));
  assert.equal(r.code, 0, r.out);
  assert.ok(material(r.out, "plain.pdf", "Text layer page one"), r.out);
  r = await council(["--attach", fx("blank.pdf")], "ru", join(W, "absent"));
  assert.equal(r.code, 2, r.out);
  assert.ok(r.out.includes("«blank.pdf»: распознавание текста недоступно — нет помощника osen-ocr"), r.out);
  ok("no helper: text-layer page read (exit 0), PDF without a text layer refused with the helper reason (exit 2)");

  const [ru, en] = await Promise.all([
    council(["--attach", join(W, "scans"), "--attach", join(W, "scans/c.pdf")], "ru", join(W, "stub-ru.sh")),
    council(["--attach", join(W, "scans")], "en", join(W, "stub-en.sh")),
  ]);
  const EN = "PDF text recognition in the folder took longer than 300 seconds — the remaining scanned PDFs were skipped";
  const RU = "распознавание PDF в папке дольше 300 секунд — остальные PDF со сканами пропущены";
  assert.equal(en.code, 0, en.out);
  for (const [n, t] of [["scans/README.md", "# Scans"], ["scans/a.pdf", "stub recognized"], ["scans/text.pdf", "Only a text layer"]]) assert.ok(material(en.out, n!, t!), en.out);
  assert.ok(en.out.includes(`scans/b.pdf — ${EN}`) && en.out.includes(`scans/c.pdf — ${EN}`), en.out);
  assert.equal(launches.get("stub-en.sh")!.size, 2, `en launches ${[...launches.get("stub-en.sh")!]}`);
  assert.ok(en.seconds < 330, `en took ${en.seconds} s`);
  ok(`folder budget (en): README, a.pdf, text.pdf collected; b.pdf and c.pdf skipped with the folder reason; 2 helper launches; ${en.seconds} s`);
  assert.equal(ru.code, 0, ru.out);
  assert.ok(material(ru.out, "c.pdf", "stub recognized") && material(ru.out, "scans/a.pdf", "stub recognized"), ru.out);
  assert.ok(ru.out.includes(`scans/b.pdf — ${RU}`) && ru.out.includes(`scans/c.pdf — ${RU}`), ru.out);
  assert.equal(launches.get("stub-ru.sh")!.size, 3, `ru launches ${[...launches.get("stub-ru.sh")!]}`);
  ok(`folder budget (ru) with c.pdf also attached explicitly: explicit c.pdf is a material, the folder record of c.pdf stays; 3 helper launches; ${ru.seconds} s`);
} catch (e) {
  clearInterval(poll);
  console.error(`FAIL ${(e as Error).message}\nkept: ${W}`);
  process.exit(1);
}
clearInterval(poll);
rmSync(W, { recursive: true, force: true });
console.log("all checks passed");

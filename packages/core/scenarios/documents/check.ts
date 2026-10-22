// Live check of local document materials (DOCX/DOCM, RTF, Word 97-2003 DOC, encrypted Office files): terminal (real council), MCP over stdio and the app's main process.
// Participants are scripted only, 0 real model calls. Every step runs twice, on ru and on en (process language, COUNCIL_LANG of the child processes).
// All files live in COUNCIL_HOME (inside the project: the collector rejects paths through symlinks).
//   COUNCIL_DEV=1 COUNCIL_HOME="$(mktemp -d "$PWD/.council-data-documents-XXXXXX")" node packages/core/scenarios/documents/check.ts
// The MCP and app parts run as child processes (packages/mcp/scenarios/documents/check.ts, apps/desktop/scenarios/documents/check.ts).
// Does not delete COUNCIL_HOME. Documents are generated in code (packages/core/src/documents/fixture.ts), no binary files.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { collectMaterials, DOC_LIMITS, documentReason, extractDocumentText, MaterialsError, setDocumentExtractorRuntime, setProcessLanguage } from "../../src/index.ts";
import { makeCfb, makeDocx, makeRtf, makeZip, p, table } from "../../src/documents/fixture.ts";
import { SANDBOX_PROFILE } from "../../src/documents/textutil.ts";

const run1 = promisify(execFile);

const repo = resolve(import.meta.dirname, "../../../..");
const home = process.env.COUNCIL_HOME;
const usage = 'COUNCIL_DEV=1 COUNCIL_HOME="$(mktemp -d "$PWD/.council-data-documents-XXXXXX")" node packages/core/scenarios/documents/check.ts';
if (process.env.COUNCIL_DEV !== "1" || !home) { console.error(`Usage: ${usage}`); process.exit(2); }
if (!existsSync(resolve(home)) || !statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0) {
  console.error(`COUNCIL_HOME ${resolve(home)} must exist and be empty. Usage: ${usage}`);
  process.exit(2);
}
const work = realpathSync(resolve(home));
const fx = join(work, "fx"), scen = join(work, "scen");
for (const d of [fx, scen]) mkdirSync(d, { recursive: true });
const SECRET = "stand-secret-value";

// ---- Expected texts (the fixtures below are built to give exactly this) ----
const EXPECTED = "Первый абзац отчёта\nВторой абзац отчёта\nЯчейка А1\tЯчейка Б1\nЯчейка А2\tЯчейка Б2\n\nСноска: источник данных";
const shaExp = createHash("sha256").update(Buffer.from(EXPECTED, "utf8")).digest("hex");
const RTF_PARAS = ["Первый абзац", "Второй абзац"];
const RTF_EXPECTED = RTF_PARAS.join("\n");
const shaRtf = createHash("sha256").update(Buffer.from(RTF_EXPECTED, "utf8")).digest("hex");
const REPORT = { body: p("Первый абзац отчёта") + p("Второй абзац отчёта") + table([["Ячейка А1", "Ячейка Б1"], ["Ячейка А2", "Ячейка Б2"]]), footnotes: `<w:footnote w:id="1">${p("Сноска: источник данных")}</w:footnote>` };

interface Texts { unavailable: string; session: RegExp; summary: (n: number, chars: number) => RegExp; rejected: string; skipped: (n: number) => RegExp; leftOut: (n: number) => RegExp; reason: Record<string, string>; nonText: string; nonTextSkipped: string }
const T: Record<"ru" | "en", Texts> = {
  ru: {
    unavailable: "не удалось извлечь текст — системная утилита textutil недоступна",
    session: /^Сессия (\S+) ·/m, summary: (n, c) => new RegExp(`^Материалы: ${n}, объём ${c} символов`, "m"), rejected: "Материалы не приняты:",
    skipped: (n) => new RegExp(`^Пропущено: ${n}$`, "m"), leftOut: (n) => new RegExp(`^Не вошло в исходный набор: ${n} `, "m"),
    reason: {
      damaged: "документ повреждён", encrypted: "документ зашифрован — пароль не запрашивается", noText: "в документе нет текста",
      ratio: "часть документа сжата сильнее чем в 200 раз", parts: "в документе больше 10000 частей", unpacked: "документ распаковывается больше чем в 512 МиБ",
      chars: "текст документа больше 20000000 знаков",
    },
    nonText: "нетекстовый файл (не UTF-8 или бинарные данные)", nonTextSkipped: "нетекстовый файл",
  },
  en: {
    unavailable: "text could not be extracted — the system utility textutil is unavailable",
    session: /^Session (\S+) ·/m, summary: (n, c) => new RegExp(`^Materials: ${n}, size ${c} characters`, "m"), rejected: "Materials not accepted:",
    skipped: (n) => new RegExp(`^Skipped: ${n}$`, "m"), leftOut: (n) => new RegExp(`^Not in the initial set: ${n} `, "m"),
    reason: {
      damaged: "document is damaged", encrypted: "document is encrypted — no password is requested", noText: "document has no text",
      ratio: "a document part is compressed more than 200 times", parts: "document has more than 10000 parts", unpacked: "document unpacks to more than 512 MiB",
      chars: "document text is longer than 20000000 characters",
    },
    nonText: "not a text file (not UTF-8 or binary data)", nonTextSkipped: "not a text file",
  },
};

// A document whose main part is written by hand (makeDocx always wraps the body in its own root element).
function docxWithMain(mainXml: string): Uint8Array {
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const x = (s: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`;
  return makeZip([
    { name: "[Content_Types].xml", data: x('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: "_rels/.rels", data: x(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`) },
    { name: "word/document.xml", data: x(mainXml) },
  ]);
}
const WNS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

// Compressible but not trivially: pseudo-random words (ratio about 2), so only the character limit is hit.
function bigText(chars: number): string {
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out: string[] = [];
  let n = 0;
  while (n < chars) {
    let w = "";
    for (let i = 3 + Math.floor(rnd() * 8); i > 0; i--) w += String.fromCharCode(97 + Math.floor(rnd() * 26));
    out.push(w);
    n += w.length + 1;
  }
  return out.join(" ").slice(0, chars);
}

// Fixtures with an expected outcome per explicit-file refusal (reason key from T[lang].reason).
let server: net.Server;
let connections = 0;
let port = 0;
function refusalFixtures(): [string, Uint8Array, string][] {
  const ent = (target: string) => `<!DOCTYPE w:document [<!ENTITY e SYSTEM "${target}">]>`;
  const doc = (inner: string) => `<w:document ${WNS}><w:body>${inner}</w:body></w:document>`;
  return [
    ["unclosed-tag", makeDocx({ body: "<w:p>" }), "damaged"],
    ["entity-file", docxWithMain(`${ent(`file://${join(work, "secret.txt")}`)}\n${doc(p("&e;"))}`), "damaged"],
    ["entity-http", docxWithMain(`${ent(`http://127.0.0.1:${port}/`)}\n${doc(p("&e;"))}`), "damaged"],
    // Only this one parses once the DOCTYPE refusal is gone (no internal subset, nothing to resolve): it is the one that notices the mutation.
    ["doctype-dtd-http", docxWithMain(`<!DOCTYPE w:document SYSTEM "http://127.0.0.1:${port}/x.dtd">\n${doc(p("текст"))}`), "damaged"],
    ["encrypted", makeDocx({ body: p("а"), extraParts: [{ name: "e.bin", data: "a", encrypted: true }] }), "encrypted"],
    ["empty", makeDocx({ body: p("") + p("   ") }), "noText"],
    ["ratio", makeDocx({ body: p("а"), extraParts: [{ name: "b.bin", data: "a".repeat(1_000_000) }] }), "ratio"],
    ["parts", makeDocx({ body: p("а"), extraParts: Array.from({ length: 10_001 }, (_, i) => ({ name: `x/${i}.bin`, data: "a" })) }), "parts"],
    ["unpacked", makeDocx({ body: p("а"), extraParts: [{ name: "l.bin", data: "a", declaredSize: 600 * 2 ** 20 }] }), "unpacked"],
    ["chars", makeDocx({ body: p(bigText(20_000_001)) }), "chars"],
  ];
}

const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_DEV: "1" };
const entry = join(repo, "packages/core/src/council.ts");
let checks = 0;
const ok = (s: string) => { checks++; console.log(`ok: ${s}`); };
const kids = new Set<ReturnType<typeof spawn>>();
type Proc = { out: string; err: string; exited: Promise<number | null> };
function proc(command: string, args: string[], env: Record<string, string>): Proc {
  const child = spawn(command, args, { env, cwd: repo });
  kids.add(child);
  const r: Proc = { out: "", err: "", exited: new Promise((res) => child.on("close", (c) => { kids.delete(child); res(c); })) };
  child.stdout.on("data", (d) => { r.out += d; });
  child.stderr.on("data", (d) => { r.err += d; });
  return r;
}
const dump = (r: Proc) => `\n--- stdout ---\n${r.out}\n--- stderr ---\n${r.err}`;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
function allFiles(d: string): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(d, e.name)) : [join(d, e.name)]));
}

type Step = { expectPrompt?: string; stance: string; solution?: string | null };
function scenario(name: string, steps: Step[]) {
  const path = join(scen, `${name}.json`);
  const body = steps.map(({ expectPrompt, stance, solution }) => ({
    ...(expectPrompt ? { expectPrompt } : {}),
    response: { stance, reasoning: "Проверка документов.", solution: solution ?? null, answers: [], questions: [], files: [] },
  }));
  writeFileSync(path, JSON.stringify({ steps: body }));
  return `scripted:${path}`;
}
/** Agreement within three turns; every request must contain the mark. */
function pair(name: string, mark?: string): string[] {
  return [
    scenario(`${name}-p1`, [{ stance: "amend", solution: "Решение по материалам.", expectPrompt: mark }, { stance: "agree", expectPrompt: mark }, { stance: "agree", expectPrompt: mark }]),
    scenario(`${name}-p2`, [1, 2, 3].map(() => ({ stance: "agree", expectPrompt: mark }))),
  ];
}
const parts = (p2: string[]) => ["--participant", p2[0]!, "--participant", p2[1]!];

/** Child stand: ok lines are forwarded, the RESULT line is parsed. */
async function subStand(what: string, script: string, dataDir: string, lang: string, extra: string[]) {
  mkdirSync(dataDir, { recursive: true });
  const r = proc(process.execPath, [join(repo, script), fx, lang, ...extra], { ...baseEnv, COUNCIL_LANG: lang, COUNCIL_HOME: dataDir });
  const code = await r.exited;
  const lines = r.out.split("\n");
  for (const l of lines) if (l && !l.startsWith("RESULT ")) console.log(l);
  if (code !== 0) throw new Error(`part "${what}" (${lang}) exited with code ${code}${r.err ? `\n${r.err}` : ""}`);
  const line = lines.find((l) => l.startsWith("RESULT "));
  assert.ok(line, `part "${what}" printed no RESULT`);
  const res = JSON.parse(line.slice(7)) as { checks: number; sha256: string; chars: number; snapshot: string; rtf: { sha256: string; chars: number; snapshot: string } };
  checks += res.checks;
  return res;
}

async function suite(lang: "ru" | "en") {
  const t = T[lang];
  setProcessLanguage(lang);
  const tag = `[${lang}]`;
  const cliHome = join(work, `cli-${lang}`), promptLog = join(work, `prompts-${lang}.jsonl`);
  mkdirSync(cliHome, { recursive: true });
  const cliEnv = { ...baseEnv, COUNCIL_LANG: lang, COUNCIL_HOME: cliHome, COUNCIL_SCRIPTED_PROMPT_LOG: promptLog, OPENAI_API_KEY: SECRET, ANTHROPIC_API_KEY: SECRET };
  const run = async (args: string[]) => { const r = proc(process.execPath, [entry, ...args], cliEnv); const code = await r.exited; return { code, r }; };
  const sdir = (id: string) => join(cliHome, "sessions", id);
  const events = (id: string) => readFileSync(join(sdir(id), "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
  const created = (id: string) => events(id).find((e) => e.type === "session_created")!.session;
  const journals = () => (existsSync(join(cliHome, "sessions")) ? readdirSync(join(cliHome, "sessions")).filter((d) => existsSync(join(cliHome, "sessions", d, "events.jsonl"))) : []);
  const sessionId = (r: Proc) => t.session.exec(r.out)?.[1] ?? assert.fail(`no session line${dump(r)}`);
  const promptLines = () => (existsSync(promptLog) ? readFileSync(promptLog, "utf8").split("\n").filter(Boolean) : []);
  const attach = (name: string, f: string, mark: string | undefined, extra: string[] = []) =>
    run(["--topic", "Что в документе?", "--attach", f, ...parts(pair(`${lang}-${name}`, mark)), "--max-rounds", "3", ...extra]);

  // ---- 1. Terminal, DOCX with paragraphs, a table and a footnote ----
  const report = join(fx, "report.docx");
  const n0 = journals().length;
  const r1 = await attach("s1", report, EXPECTED);
  assert.equal(r1.code, 0, `code ${r1.code}${dump(r1.r)}`);
  assert.match(r1.r.out, t.summary(1, EXPECTED.length), `summary${dump(r1.r)}`);
  const id1 = sessionId(r1.r);
  const m1 = created(id1).materials;
  assert.equal(m1.length, 1);
  assert.ok(String(m1[0].name).endsWith("report.docx"), m1[0].name);
  assert.deepEqual([m1[0].chars, m1[0].sha256], [EXPECTED.length, shaExp]);
  const snap1 = join(sdir(id1), "materials", "m1.txt");
  assert.equal(readFileSync(snap1, "utf8"), EXPECTED, "m1.txt");
  assert.ok(!events(id1).some((e) => e.type === "turn_failed"), "turn_failed");
  const lines = promptLines();
  assert.ok(lines.length >= 2 && lines.every((l) => (JSON.parse(l) as { prompt: string }).prompt.includes(EXPECTED)), "prompt log: not every request carries the text");
  const zone = [readFileSync(join(sdir(id1), "events.jsonl"), "utf8"), r1.r.out, r1.r.err, ...allFiles(sdir(id1)).map((f) => readFileSync(f, "latin1"))];
  assert.ok(!zone.some((z) => z.includes("PK\x03\x04") || z.includes("word/document.xml")), "document bytes in the session folder, journal or output");
  assert.equal(journals().length, n0 + 1);
  ok(`${tag} 1: one material, m1.txt = paragraphs in order + table rows with tabs + footnote after a blank line; ${lines.length} turn requests carry the text; no document bytes in the session`);

  // ---- 2. Same bytes as .bin and .docm with a macro ----
  copyFileSync(report, join(fx, "report.bin"));
  const sha2: string[] = [];
  for (const f of ["report.bin", "report-macro.docm"]) {
    const r = await attach(`s2-${f}`, join(fx, f), EXPECTED);
    assert.equal(r.code, 0, `${f}: code ${r.code}${dump(r.r)}`);
    sha2.push(created(sessionId(r.r)).materials[0].sha256);
  }
  assert.deepEqual(sha2, [shaExp, shaExp]);
  ok(`${tag} 2: report.bin and a .docm with vbaProject.bin give the same sha256 ${shaExp.slice(0, 12)}…, macro text absent from the material`);

  // ---- 3. MCP and app parts ----
  const mcp = await subStand("MCP", "packages/mcp/scenarios/documents/check.ts", join(work, `mcp-${lang}`), lang, [t.reason.damaged]);
  const desk = await subStand("app", "apps/desktop/scenarios/documents/check.ts", join(work, `desktop-${lang}`), lang, [t.reason.damaged]);
  for (const [what, r] of [["terminal", { sha256: m1[0].sha256, chars: m1[0].chars, snapshot: snap1 }], ["MCP", mcp], ["app", desk]] as const) {
    assert.equal(r.sha256, shaExp, `${what}: sha256`);
    assert.equal(r.chars, EXPECTED.length, `${what}: chars`);
    assert.equal(readFileSync(r.snapshot, "utf8"), EXPECTED, `${what}: snapshot`);
  }
  ok(`${tag} 3: parity: chars ${EXPECTED.length} and sha256 are identical in the terminal, MCP council_start and the app main modules`);

  // ---- L1/L2. RTF: terminal, then the same text, chars and sha256 through MCP and the app ----
  const rtfRun = await attach("l1", join(fx, "note.rtf"), RTF_EXPECTED);
  assert.equal(rtfRun.code, 0, `code ${rtfRun.code}${dump(rtfRun.r)}`);
  assert.match(rtfRun.r.out, t.summary(1, RTF_EXPECTED.length), `summary${dump(rtfRun.r)}`);
  const idRtf = sessionId(rtfRun.r);
  const mRtf = created(idRtf).materials;
  assert.equal(mRtf.length, 1);
  assert.ok(String(mRtf[0].name).endsWith("note.rtf"), mRtf[0].name);
  assert.deepEqual([mRtf[0].chars, mRtf[0].sha256], [RTF_EXPECTED.length, shaRtf]);
  const snapRtf = join(sdir(idRtf), "materials", "m1.txt");
  const snapText = readFileSync(snapRtf, "utf8");
  assert.equal(snapText, RTF_EXPECTED, "m1.txt");
  assert.ok(RTF_PARAS.every((q) => snapText.includes(q)) && snapText.indexOf(RTF_PARAS[0]!) < snapText.indexOf(RTF_PARAS[1]!), "paragraphs are missing or out of order");
  assert.ok(!allFiles(sdir(idRtf)).some((f) => readFileSync(f, "latin1").includes("{\\rtf")), "RTF bytes in the session folder");
  const rtfPrompts = promptLines().filter((l) => (JSON.parse(l) as { prompt: string }).prompt.includes(RTF_EXPECTED));
  assert.ok(rtfPrompts.length >= 2, "the turn requests do not carry the RTF text");
  ok(`${tag} L1: council --attach note.rtf — the summary counts 1 material named note.rtf in the journal, m1.txt = both paragraphs in order, no RTF bytes, ${rtfPrompts.length} turn requests carry the text`);
  for (const [what, r] of [["MCP", mcp.rtf], ["app", desk.rtf]] as const) {
    assert.deepEqual([r.sha256, r.chars], [shaRtf, RTF_EXPECTED.length], `${what}: rtf sha256/chars`);
    assert.equal(readFileSync(r.snapshot, "utf8"), RTF_EXPECTED, `${what}: rtf snapshot`);
  }
  ok(`${tag} L2: RTF parity: chars ${RTF_EXPECTED.length} and sha256 are identical in the terminal, MCP council_start and the app main modules`);

  // ---- L3. Word 97-2003 DOC built by textutil, saved as legacy.bin; L4. fake.rtf is plain text ----
  const rLegacy = await attach("l3", join(fx, "legacy.bin"), "Первая строка");
  assert.equal(rLegacy.code, 0, dump(rLegacy.r));
  const legacyText = readFileSync(join(sdir(sessionId(rLegacy.r)), "materials", "m1.txt"), "utf8");
  assert.ok(legacyText.includes("Первая строка") && legacyText.includes("Вторая строка"), `legacy text: ${legacyText}`);
  assert.ok(!readFileSync(join(sdir(sessionId(rLegacy.r)), "materials", "m1.txt"), "latin1").includes("\xd0\xcf\x11\xe0"), "CFB bytes in the snapshot");
  ok(`${tag} L3: a .doc made by textutil and named legacy.bin is accepted by content; both fragments are in the text`);
  const plain = "just notes, not RTF\n";
  const rFake = await attach("l4", join(fx, "fake.rtf"), "just notes");
  assert.equal(rFake.code, 0, dump(rFake.r));
  assert.equal(readFileSync(join(sdir(sessionId(rFake.r)), "materials", "m1.txt"), "utf8"), plain);
  ok(`${tag} L4: fake.rtf without {\\rtf is accepted as plain text`);

  // ---- L5. Encrypted Office: explicit refusal with the encrypted reason, skipped in a folder; L6. other CFB, damaged CFB ----
  const refuse = async (name: string, f: string, reason: string, maxMs = Infinity) => {
    const sessionsBefore = journals().length, calls = promptLines().length, t0 = Date.now();
    const r = await run(["--topic", "t", "--attach", f, ...parts(okPairL), "--max-rounds", "1"]);
    assert.equal(r.code, 2, `${name}: code ${r.code}${dump(r.r)}`);
    assert.equal(r.r.out, "", `${name}: stdout${dump(r.r)}`);
    assert.equal(r.r.err, `${t.rejected}\n  «${basename(f)}»: ${reason}\n`, `${name}: stderr${dump(r.r)}`);
    assert.ok(Date.now() - t0 < maxMs, `${name}: took ${Date.now() - t0} ms`);
    assert.equal(journals().length, sessionsBefore, `${name}: a session appeared`);
    assert.equal(promptLines().length, calls, `${name}: a participant was called`);
  };
  const okPairL = pair(`${lang}-l5`);
  await refuse("encrypted", join(fx, "secret.docx"), t.reason.encrypted);
  const rDir = await attach("l5d", join(fx, "encdir"), undefined);
  assert.equal(rDir.code, 0, dump(rDir.r));
  const namesDir = (created(sessionId(rDir.r)).materials as { name: string }[]).map((m) => m.name);
  assert.ok(namesDir.length === 1 && namesDir[0]!.endsWith("README.md"), `collected: ${namesDir}`);
  assert.match(rDir.r.out, t.skipped(1), dump(rDir.r));
  assert.ok(rDir.r.out.split("\n").some((l) => l.includes("secret.docx") && l.includes(t.reason.encrypted)), `no skipped line with the reason${dump(rDir.r)}`);
  assert.ok(!t.nonText.includes(t.reason.encrypted) && !rDir.r.out.includes(t.nonTextSkipped), "the non-text reason is shown for an encrypted file");
  ok(`${tag} L5: an encrypted CFB named secret.docx — explicit attach: code 2, "${t.rejected}" + "${t.reason.encrypted}", no non-text reason; in a folder it is skipped with that reason, README collected`);
  await refuse("no-stream", join(fx, "nostream.bin"), t.nonText);
  await refuse("loop", join(fx, "loop.doc"), t.reason.damaged, 5000);
  ok(`${tag} L6: a CFB with neither WordDocument nor EncryptedPackage keeps "${t.nonText}"; a CFB with a looping directory chain is "${t.reason.damaged}" in under 5 s`);

  // ---- 4. Tracked changes, header, comments ----
  const tracked = makeDocx({
    body: `<w:p><w:r><w:t xml:space="preserve">Было </w:t></w:r><w:ins w:id="1"><w:r><w:t>вставлено</w:t></w:r></w:ins><w:del w:id="2"><w:r><w:delText>удалено</w:delText></w:r></w:del></w:p>`,
    header: p("колонтитул-секрет"), comments: `<w:comment w:id="1">${p("комментарий-секрет")}</w:comment>`,
  });
  writeFileSync(join(fx, "tracked.docx"), tracked);
  const lines4 = promptLines().length;
  const r4 = await attach("s4", join(fx, "tracked.docx"), "Было вставлено");
  assert.equal(r4.code, 0, dump(r4.r));
  const txt4 = readFileSync(join(sdir(sessionId(r4.r)), "materials", "m1.txt"), "utf8");
  assert.equal(txt4, "Было вставлено");
  const fresh4 = promptLines().slice(lines4);
  assert.ok(fresh4.length >= 2 && fresh4.every((l) => { const q = (JSON.parse(l) as { prompt: string }).prompt; return q.includes("Было вставлено") && !/колонтитул-секрет|комментарий-секрет|вставленоудалено/.test(q); }), "requests of step 4");
  ok(`${tag} 4: inserted text is present; deleted text, header and comment are absent from the snapshot and the requests`);

  // ---- 5. Folder ----
  const proj = join(fx, "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "README.md"), "Описание проекта.\n");
  writeFileSync(join(proj, "spec.docx"), makeDocx({ body: p("Спецификация системы для проверки лимита") }));
  writeFileSync(join(proj, "code.ts"), "x".repeat(500));
  const r5 = await attach("s5", proj, undefined, ["--materials-chars", "200"]);
  assert.equal(r5.code, 0, dump(r5.r));
  const names5 = (created(sessionId(r5.r)).materials as { name: string }[]).map((m) => m.name);
  assert.ok(names5.length === 2 && names5.some((n) => n.endsWith("README.md")) && names5.some((n) => n.endsWith("spec.docx")), `taken: ${names5}`);
  assert.match(r5.r.out, t.leftOut(1), dump(r5.r));
  assert.ok(r5.r.out.includes("code.ts"), "code.ts is not named among the left-out files");
  const bad = join(fx, "projbad");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "README.md"), "Описание проекта.\n");
  writeFileSync(join(bad, "broken.docx"), makeDocx({ body: "<w:p>" }));
  const r5b = await attach("s5b", bad, undefined);
  assert.equal(r5b.code, 0, dump(r5b.r));
  const names5b = (created(sessionId(r5b.r)).materials as { name: string }[]).map((m) => m.name);
  assert.ok(names5b.length === 1 && names5b[0]!.endsWith("README.md"), `collected: ${names5b}`);
  assert.match(r5b.r.out, t.skipped(1), dump(r5b.r));
  assert.ok(r5b.r.out.split("\n").some((l) => l.includes("broken.docx") && l.includes(t.reason.damaged)), `no skipped line with the reason${dump(r5b.r)}`);
  ok(`${tag} 5: over the limit the Word file is chosen as a description (README + spec.docx taken, code.ts left out); a damaged .docx is skipped with "${t.reason.damaged}", README collected`);

  // ---- 6. Explicit-file refusals ----
  const okPair = pair(`${lang}-s6`);
  const promptsBefore = promptLines().length;
  const nBefore = journals().length;
  const secretFile = join(work, "secret.txt");
  writeFileSync(secretFile, "file-entity-secret");
  const cases = refusalFixtures();
  for (const [name, bytes, key] of cases) {
    const f = join(fx, `refuse-${name}.docx`);
    writeFileSync(f, bytes);
    const r = await run(["--topic", "t", "--attach", f, ...parts(okPair), "--max-rounds", "1"]);
    assert.equal(r.code, 2, `${name}: code ${r.code}${dump(r.r)}`);
    assert.equal(r.r.out, "", `${name}: stdout${dump(r.r)}`);
    assert.equal(r.r.err, `${t.rejected}\n  «${basename(f)}»: ${t.reason[key]}\n`, `${name}: stderr${dump(r.r)}`);
    assert.equal(journals().length, nBefore, `${name}: a session appeared`);
  }
  assert.equal(promptLines().length, promptsBefore, "a participant was called");
  ok(`${tag} 6: ${cases.length} refusals (unclosed tag, DOCTYPE with file/http entity and DTD, encrypted, empty, ratio >200, 10001 parts, unpacked >512 MiB, >20000000 chars): code 2, "${t.rejected}" + the exact reason, no sessions, no participant calls`);

  // ---- 7. Plain ZIP ----
  const zipF = join(fx, "plain.zip");
  writeFileSync(zipF, makeZip([{ name: "a.txt", data: "hi" }]));
  const r7 = await run(["--topic", "t", "--attach", zipF, ...parts(okPair), "--max-rounds", "1"]);
  assert.equal(r7.code, 2, dump(r7.r));
  assert.equal(r7.r.err, `${t.rejected}\n  «${basename(zipF)}»: ${t.nonText}\n`, dump(r7.r));
  assert.ok(!r7.r.err.includes(t.reason.damaged));
  ok(`${tag} 7: a plain ZIP is refused as a non-text file ("${t.nonText}"), not as damaged`);
}

async function legacyInProcess() {
  const opts = { materialsChars: 100_000, materialsIgnore: [] as string[] };
  // ---- L7. textutil or sandbox-exec missing: the reason, and textutil is never started without the sandbox ----
  const counter = join(work, "textutil-starts.txt");
  const stub = join(fx, "textutil-stub.sh");
  writeFileSync(stub, `#!/bin/sh\necho started >> ${JSON.stringify(counter)}\n`, { mode: 0o755 });
  try {
    setDocumentExtractorRuntime({ tools: { sandbox: join(work, "no-such-sandbox-exec"), textutil: stub } });
    for (const lang of ["ru", "en"] as const) {
      setProcessLanguage(lang);
      for (const f of ["note.rtf", "legacy.bin"]) {
        const file = join(fx, f);
        try { collectMaterials([file], opts); assert.fail(`${f}: expected a refusal`); } catch (e) {
          assert.ok(e instanceof MaterialsError, String(e));
          assert.deepEqual(e.reasons, [`«${file}»: ${T[lang].unavailable}`]);
        }
      }
    }
    assert.ok(!existsSync(counter), "the textutil stub was started without the sandbox");
    ok("L7: with a missing sandbox-exec, RTF and DOC give \"" + T.ru.unavailable + "\" / \"" + T.en.unavailable + "\"; the textutil stub was never started (counter file absent)");
  } finally {
    setDocumentExtractorRuntime();
  }

  // ---- L8. The sandbox profile: no writes, no connections ----
  setProcessLanguage("en");
  let hits = 0;
  const listener = net.createServer((s) => { hits++; s.destroy(); });
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  const lport = (listener.address() as net.AddressInfo).port;
  const sandboxed = (...cmd: string[]) => run1("/usr/bin/sandbox-exec", ["-p", SANDBOX_PROFILE, ...cmd], { env: {} });
  const outcome = (p2: Promise<unknown>) => p2.then(() => 0, (e: { code?: number }) => e.code ?? -1);
  const target = join(fx, "touched.txt");
  assert.notEqual(await outcome(sandboxed("/usr/bin/touch", target)), 0, "touch succeeded under the profile");
  assert.ok(!existsSync(target), "the sandboxed touch created a file");
  assert.equal(await outcome(run1("/usr/bin/touch", [target])), 0, "control: touch without the sandbox failed");
  assert.ok(existsSync(target), "control: no file without the sandbox");
  const nc = ["-z", "-w", "2", "127.0.0.1", String(lport)];
  assert.notEqual(await outcome(sandboxed("/usr/bin/nc", ...nc)), 0, "nc connected under the profile");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(hits, 0, `the listener got ${hits} connections from the sandboxed nc`);
  assert.equal(await outcome(run1("/usr/bin/nc", nc)), 0, "control: nc without the sandbox did not connect");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(hits, 1, `control: expected 1 connection, got ${hits}`);
  ok("L8: SANDBOX_PROFILE refuses a file write (touch, file absent) and a connection (nc, 0 hits); the control runs without the sandbox write the file and connect (1 hit)");
  hits = 0;
  const url = `http://127.0.0.1:${lport}`;
  const linkRtf = `{\\rtf1\\ansi {\\field{\\*\\fldinst HYPERLINK "${url}/link"}{\\fldrslt link text}} {\\field{\\*\\fldinst INCLUDEPICTURE "${url}/pic.png"}{\\fldrslt picture text}}\\par}`;
  const linkFile = join(fx, "links.rtf");
  writeFileSync(linkFile, linkRtf);
  const got = collectMaterials([linkFile], opts).materials[0]!.text;
  assert.ok(got.includes("link text"), `links.rtf text: ${got}`);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(hits, 0, `the listener got ${hits} connections from an RTF with HYPERLINK and INCLUDEPICTURE`);
  listener.close();
  ok("L8: an RTF with HYPERLINK and INCLUDEPICTURE fields pointing at the local listener is converted and makes 0 connections");

  // ---- L9. Reduced limits: the refusal names the limit ----
  const bigRtf = new Uint8Array(Buffer.from(makeRtf(Array.from({ length: 40_000 }, () => "строка для проверки предела входа"))));
  const small = new Uint8Array(Buffer.from(makeRtf(["строка", "ещё строка"])));
  const lim = (over: Partial<typeof DOC_LIMITS>) => ({ ...DOC_LIMITS, ...over });
  const refused = (bytes: Uint8Array, over: Partial<typeof DOC_LIMITS>, code: string, mention: RegExp) => {
    const l = lim(over);
    const r = extractDocumentText(bytes, l);
    assert.ok(!r.ok && r.code === code, `expected ${code}, got ${JSON.stringify(r)}`);
    assert.match(documentReason(r, l), mention);
  };
  assert.ok(bigRtf.length > 1 << 20, `the big RTF is ${bigRtf.length} bytes`);
  refused(bigRtf, { bytes: 1 << 20 }, "bytes", /larger than 1 MiB/);
  refused(small, { chars: 5 }, "chars", /longer than 5/);
  refused(small, { ms: 1 }, "timeout", /longer than/);
  ok("L9: reduced limits give refusals that name the limit: input 1 MiB, output 5 characters, time 1 ms (source files are checked unchanged at the end)");
}

async function inProcess() {
  // ---- 8 and 9. Extraction process: environment and one start per file ----
  setProcessLanguage("en");
  const counter = join(work, "spawns.jsonl");
  const wrap = join(fx, "wrap.ts");
  // The wrapper records the environment it was started with and then runs the real doc-extract.ts in the same process.
  // That proves what the real extractor sees: the default runtime passes env {}, the stand does not override it.
  writeFileSync(wrap, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(counter)}, JSON.stringify(Object.keys(process.env)) + "\\n");\nawait import(${JSON.stringify(join(repo, "packages/core/src/documents/doc-extract.ts"))});\n`);
  const saved = { o: process.env.OPENAI_API_KEY, a: process.env.ANTHROPIC_API_KEY, g: process.env.GITHUB_TOKEN };
  process.env.OPENAI_API_KEY = SECRET;
  process.env.ANTHROPIC_API_KEY = SECRET;
  process.env.GITHUB_TOKEN = SECRET;
  try {
    setDocumentExtractorRuntime({ script: wrap });
    const f = join(fx, "cache.docx");
    writeFileSync(f, makeDocx({ body: p("Текст для проверки кэша") }));
    const opts = { materialsChars: 10_000, materialsIgnore: [] as string[] };
    const a = collectMaterials([f], opts).materials[0]!;
    const b = collectMaterials([f], opts).materials[0]!;
    assert.equal(a.text, "Текст для проверки кэша");
    assert.equal(b.sha256, a.sha256);
    const spawns = readFileSync(counter, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    assert.equal(spawns.length, 1, `the extraction process was started ${spawns.length} times for two collections`);
    ok("9: the second collection of the same file in one process does not start the extraction process again (1 start for 2 collections)");
    // macOS itself adds __CF_USER_TEXT_ENCODING to every process; nothing else may be there.
    assert.deepEqual(spawns[0]!.filter((k) => k !== "__CF_USER_TEXT_ENCODING"), [], `the extraction process saw environment variables: ${spawns[0]}`);
    ok("8: with OPENAI_API_KEY, ANTHROPIC_API_KEY and GITHUB_TOKEN set in the parent, the extraction process starts with an empty environment (only the macOS-added __CF_USER_TEXT_ENCODING is allowed)");
  } finally {
    setDocumentExtractorRuntime();
    for (const [k, v] of [["OPENAI_API_KEY", saved.o], ["ANTHROPIC_API_KEY", saved.a], ["GITHUB_TOKEN", saved.g]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

async function main() {
  server = net.createServer((s) => { connections++; s.destroy(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as net.AddressInfo).port;
  writeFileSync(join(fx, "report.docx"), makeDocx(REPORT));
  writeFileSync(join(fx, "report-macro.docm"), makeDocx({ ...REPORT, macro: true }));
  writeFileSync(join(fx, "expected.txt"), EXPECTED);
  writeFileSync(join(fx, "broken.docx"), makeDocx({ body: "<w:p>" }));
  // RTF and legacy fixtures (change 211)
  writeFileSync(join(fx, "note.rtf"), makeRtf(RTF_PARAS));
  writeFileSync(join(fx, "expected-rtf.txt"), RTF_EXPECTED);
  writeFileSync(join(fx, "x.rtf"), makeRtf(["Первая строка", "Вторая строка"]));
  await run1("/usr/bin/textutil", ["-convert", "doc", "-output", join(fx, "legacy.bin"), join(fx, "x.rtf")]);
  writeFileSync(join(fx, "fake.rtf"), "just notes, not RTF\n");
  writeFileSync(join(fx, "secret.docx"), makeCfb({ streams: ["EncryptedPackage", "EncryptionInfo"] }));
  mkdirSync(join(fx, "encdir"), { recursive: true });
  writeFileSync(join(fx, "encdir", "README.md"), "Описание проекта.\n");
  writeFileSync(join(fx, "encdir", "secret.docx"), makeCfb({ streams: ["EncryptedPackage", "EncryptionInfo"] }));
  writeFileSync(join(fx, "nostream.bin"), makeCfb({ streams: ["Workbook"] }));
  writeFileSync(join(fx, "loop.doc"), makeCfb({ streams: ["WordDocument"], loop: true }));
  const srcBefore = Object.fromEntries(allFiles(fx).map((f) => [f, sha(readFileSync(f))]));
  const keep = ["report.docx", "report-macro.docm", "broken.docx", "note.rtf", "legacy.bin", "fake.rtf", "secret.docx", "nostream.bin", "loop.doc", "encdir/README.md", "encdir/secret.docx"].map((n) => join(fx, n));
  for (const lang of ["ru", "en"] as const) await suite(lang);
  await inProcess();
  await legacyInProcess();
  for (const f of keep) assert.equal(sha(readFileSync(f)), srcBefore[f], `${f} changed`);
  ok("source documents are byte-identical after all parts");
  const files = allFiles(work).filter((f) => !f.startsWith(fx));
  assert.ok(!files.some((f) => readFileSync(f, "latin1").includes(SECRET)), "the control secret value was found in the stand files");
  ok("the control secret value is absent from journals, snapshots and logs");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(connections, 0, `the local server got ${connections} connections`);
  ok("8: the local HTTP server got 0 connections during all document extractions (DOCTYPE with http entity and DTD included)");
  ok("0 real model calls: all parts use scripted participants only");
  server.close();
}

let failed = false;
const guard = setTimeout(() => { console.error(`FAILED: the stand did not finish within 900 seconds\nStand left in place: ${work}`); for (const k of kids) k.kill("SIGKILL"); process.exit(1); }, 900000);
try {
  await main();
  console.log(`Result: all checks passed (${checks})`);
} catch (e) {
  failed = true;
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}\nStand left in place: ${work}`);
} finally {
  clearTimeout(guard);
  for (const k of kids) k.kill("SIGKILL");
}
process.exit(failed ? 1 : 0);

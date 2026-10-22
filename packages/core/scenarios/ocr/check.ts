// Live check of image materials (text recognition by the osen-ocr helper): terminal (real council), MCP over stdio and the app's main process.
// Participants are scripted only, 0 real model calls. Every part runs on ru and on en (process language, COUNCIL_LANG of the child processes).
// All files live in COUNCIL_HOME (inside the project: the collector rejects paths through symlinks).
//   COUNCIL_DEV=1 COUNCIL_HOME="$(mktemp -d "$PWD/.council-data-ocr-XXXXXX")" node packages/core/scenarios/ocr/check.ts
// The MCP and app parts run as child processes (packages/mcp/scenarios/ocr/check.ts, apps/desktop/scenarios/ocr/check.ts).
// Builds the helper (scripts/build-ocr.ts) when bin/ is missing. Deletes COUNCIL_HOME on success, prints its path on failure.
// Images are drawn by bin/osen-ocr-fixture (WebP by headless Chrome); stub helpers are shell scripts (sandbox-exec: absolute tool paths, no writes).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync, ftruncateSync, openSync, closeSync } from "node:fs";
import net from "node:net";
import { basename, join, resolve } from "node:path";
import { OCR_LIMITS, runOcrHelper, setOcrRuntime, setProcessLanguage } from "../../src/index.ts";
import { makeImage } from "../../src/ocr/fixture.ts";
import { connect } from "../../../../apps/desktop/scenarios/mockup-tokens/cdp.ts";

const repo = resolve(import.meta.dirname, "../../../..");
const home = process.env.COUNCIL_HOME;
const usage = 'COUNCIL_DEV=1 COUNCIL_HOME="$(mktemp -d "$PWD/.council-data-ocr-XXXXXX")" node packages/core/scenarios/ocr/check.ts';
if (process.env.COUNCIL_DEV !== "1" || !home) { console.error(`Usage: ${usage}`); process.exit(2); }
if (!existsSync(resolve(home)) || !statSync(resolve(home)).isDirectory() || readdirSync(resolve(home)).length > 0) {
  console.error(`COUNCIL_HOME ${resolve(home)} must exist and be empty. Usage: ${usage}`);
  process.exit(2);
}
const work = realpathSync(resolve(home));
const fx = join(work, "fx"), stubs = join(work, "stubs");
for (const d of [fx, stubs]) mkdirSync(d, { recursive: true });
const SECRET = "stand-secret-value";
const started = Date.now();

// ---- Helper and fixtures ----
const REAL = join(repo, "packages/core/src/ocr/bin/osen-ocr");
if (!existsSync(REAL) || !existsSync(`${REAL}-fixture`)) {
  const b = spawnSync(process.execPath, [join(repo, "scripts/build-ocr.ts")], { cwd: repo, stdio: "inherit" });
  if (b.status !== 0) { console.error("FAILED: could not build the OCR helper (needs macOS and swiftc)"); process.exit(1); }
}
const LINES = ["Договор поставки", "Срок оплаты"];
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
function assertPhrases(text: string, what: string) {
  const n = norm(text), a = n.indexOf(norm(LINES[0]!)), b = n.indexOf(norm(LINES[1]!));
  assert.ok(a >= 0 && b > a, `${what}: both phrases in order expected, got ${JSON.stringify(text)}`);
}

// Reasons (numbers from OCR_LIMITS); the texts are written out here on purpose, independent of the catalog.
const MIB = OCR_LIMITS.bytes / 2 ** 20, MP = OCR_LIMITS.pixels / 1_000_000, SEC = OCR_LIMITS.ms / 1000, RSS = OCR_LIMITS.rssBytes / 2 ** 20;
interface Texts { session: RegExp; rejected: string; skipped: (n: number) => RegExp; reason: Record<string, string> }
const T: Record<"ru" | "en", Texts> = {
  ru: {
    session: /^Сессия (\S+) ·/m, rejected: "Материалы не приняты:", skipped: (n) => new RegExp(`^Пропущено: ${n}$`, "m"),
    reason: {
      missing: "распознавание текста недоступно — нет помощника osen-ocr", noText: "на изображении не найден текст", damaged: "изображение повреждено",
      bytes: `изображение больше ${MIB} МиБ`, pixels: `изображение больше ${MP} мегапикселей`, timeout: `распознавание текста дольше ${SEC} секунд`,
      memory: `распознавание текста заняло больше ${RSS} МиБ памяти`, folder: `в папке больше ${OCR_LIMITS.folderImages} изображений — распознаны первые ${OCR_LIMITS.folderImages}`,
    },
  },
  en: {
    session: /^Session (\S+) ·/m, rejected: "Materials not accepted:", skipped: (n) => new RegExp(`^Skipped: ${n}$`, "m"),
    reason: {
      missing: "text recognition is unavailable — the osen-ocr helper is missing", noText: "no text found in the image", damaged: "the image is damaged",
      bytes: `the image is larger than ${MIB} MiB`, pixels: `the image is larger than ${MP} megapixels`, timeout: `text recognition took longer than ${SEC} seconds`,
      memory: `text recognition used more than ${RSS} MiB of memory`, folder: `the folder has more than ${OCR_LIMITS.folderImages} images — the first ${OCR_LIMITS.folderImages} were recognized`,
    },
  },
};

// ---- Stub helpers: #!/bin/sh, absolute tool paths, no redirects to /dev/null (writes are denied under the profile) ----
let stubN = 0;
function stub(body: string, drain = true): string {
  const f = join(stubs, `stub-${stubN++}.sh`);
  writeFileSync(f, `#!/bin/sh\n${drain ? "C=$(/bin/cat)\n" : ""}${body}\n`);
  chmodSync(f, 0o755);
  return f;
}
const printing = (obj: unknown) => stub(`printf '%s\\n' '${JSON.stringify(obj)}'`);
// A distinct line per image: the md5 of the bytes read from stdin.
const md5Stub = () => stub(`H=$(/sbin/md5 -q)\nprintf '{"ok":true,"lines":[{"t":"%s","x":0,"y":0,"w":0.5,"h":0.1}]}\\n' "$H"`, false);
const hangStub = () => stub("exec /bin/sleep 60");

/** A PNG header with the given size (no image data), padded to make the bytes distinct. */
function pngHeader(w: number, h: number, pad = 0): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); ihdr.write("IHDR", 4, "latin1"); ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12); ihdr.writeUInt8(8, 16); ihdr.writeUInt8(2, 17);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.from(`pad${pad}`)]);
}

// ---- WebP: ImageIO cannot write it; headless Chrome canvas can ----
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
async function chromeWebp(): Promise<Buffer | undefined> {
  if (!existsSync(CHROME)) return undefined;
  const profile = join(work, "chrome-profile");
  const chrome = spawn(CHROME, ["--headless=new", "--no-first-run", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const ws = await new Promise<string>((ok, bad) => {
    let buf = "";
    chrome.stderr.on("data", (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) ok(m[1]!); });
    chrome.on("exit", () => bad(new Error(`Chrome did not start: ${buf}`)));
  });
  try {
    const list = (await (await fetch(`http://127.0.0.1:${new URL(ws).port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const cdp = await connect(list.find((t) => t.type === "page")!.webSocketDebuggerUrl);
    try {
      // The drawing code is a constant; the lines are passed as call arguments (data), never spliced into the code.
      const draw = "function (lines) { const c = document.createElement('canvas'); c.width = 1200; c.height = 400; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 1200, 400); x.fillStyle = '#000'; x.font = 'bold 64px Helvetica, Arial, sans-serif'; lines.forEach((l, i) => x.fillText(l, 40, 130 + i * 120)); return c.toDataURL('image/webp', 1); }";
      const global = await cdp.send("Runtime.evaluate", { expression: "globalThis" });
      const r = await cdp.send("Runtime.callFunctionOn", { objectId: global.result.objectId, functionDeclaration: draw, arguments: [{ value: LINES }], returnByValue: true });
      const url = String(r.result.value);
      assert.ok(url.startsWith("data:image/webp;base64,"), `Chrome gave ${url.slice(0, 30)}`);
      return Buffer.from(url.slice(23), "base64");
    } finally { cdp.close(); }
  } finally {
    const browser = await connect(ws);
    await browser.send("Browser.close").catch(() => {});
    await new Promise((r) => (chrome.exitCode !== null ? r(null) : chrome.on("exit", r)));
    rmSync(profile, { recursive: true, force: true });
  }
}

// ---- Process helpers ----
const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_DEV: "1" };
const entry = join(repo, "packages/core/src/council.ts");
const scenDir = join(repo, "packages/core/scenarios/consensus");
const consensus = ["--participant", `scripted:${join(scenDir, "p1.json")}`, "--participant", `scripted:${join(scenDir, "p2.json")}`];
let checks = 0;
const ok = (s: string) => { checks++; console.log(`ok: ${s}`); };
const kids = new Set<ReturnType<typeof spawn>>();
type Proc = { out: string; err: string; exited: Promise<number | null> };
const captured: string[] = [];
function proc(command: string, args: string[], env: Record<string, string>): Proc {
  const child = spawn(command, args, { env, cwd: repo });
  kids.add(child);
  const r: Proc = { out: "", err: "", exited: new Promise((res) => child.on("close", (c) => { kids.delete(child); captured.push(r.out, r.err); res(c); })) };
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

// ---- Cases shared with the MCP and app parts (manifest.json) ----
interface Case { id: string; kind: "ok" | "refuse" | "folder"; path: string; helper?: string }
interface Outcome { items: { name: string; sha: string; chars: number }[]; m1: string; skipped: { name: string; reason: string }[] }
const fmts = ["png", "jpeg", "tiff", "gif", "bmp", "heic"] as const;
const fixtureImages: Record<string, Buffer> = {};
let webp: Buffer | undefined;
let server: net.Server;
let connections = 0;
let port = 0;

function buildFixtures() {
  for (const f of fmts) { fixtureImages[f] = makeImage(f, LINES); writeFileSync(join(fx, `shot.${f}`), fixtureImages[f]!); }
  if (webp) writeFileSync(join(fx, "shot.webp"), webp);
  copyFileSync(join(fx, "shot.jpeg"), join(fx, "photo.txt"));
  copyFileSync(join(fx, "shot.png"), join(fx, "scan.dat"));
  // Text files that look like the weak image signatures BM and II*: they stay text materials.
  writeFileSync(join(fx, "bm.txt"), "BM is a look-alike of the bitmap signature.\nДоговор оформлен как обычный текст.\n");
  writeFileSync(join(fx, "ii.txt"), "II*text that starts like a TIFF header.\nСрок оплаты указан в договоре.\n");
  writeFileSync(join(fx, "blank.png"), makeImage("png", []));
  writeFileSync(join(fx, "truncated.png"), fixtureImages.png!.subarray(0, 40));
  const big = join(fx, "big.png");
  writeFileSync(big, pngHeader(10, 10));
  const fd = openSync(big, "r+"); ftruncateSync(fd, OCR_LIMITS.bytes + 2 ** 20); closeSync(fd);
  writeFileSync(join(fx, "huge.png"), pngHeader(10001, 10001));
  // Folder for the limit: README, a header-damaged image that sorts first, 60 images with distinct bytes.
  const proj = join(fx, "proj");
  mkdirSync(proj);
  writeFileSync(join(proj, "README.md"), "Project description.\n");
  writeFileSync(join(proj, "000-broken.png"), Buffer.concat([pngHeader(1, 1).subarray(0, 8), Buffer.from("garbage")]));
  for (let i = 1; i <= 60; i++) writeFileSync(join(proj, `img-${String(i).padStart(2, "0")}.png`), pngHeader(i, 1, i));
  // The same layout with real pictures (real helper).
  const real = join(fx, "realproj");
  mkdirSync(real);
  writeFileSync(join(real, "README.md"), "Project description.\n");
  writeFileSync(join(real, "000-broken.png"), readFileSync(join(proj, "000-broken.png")));
  for (let i = 1; i <= 60; i++) writeFileSync(join(real, `img-${String(i).padStart(2, "0")}.png`), makeImage("png", [`Файл номер ${i}`], { width: 700, height: 200 }));
}

function cases(): Case[] {
  const okIds = [...fmts, ...(webp ? ["webp"] : [])].map((f) => ({ id: `shot.${f}`, kind: "ok" as const, path: join(fx, `shot.${f}`) }));
  const plain = ["photo.txt", "scan.dat", "bm.txt", "ii.txt"].map((n) => ({ id: n, kind: "ok" as const, path: join(fx, n) }));
  const ref = (id: string, file: string, helper?: string): Case => ({ id, kind: "refuse", path: join(fx, file), ...(helper ? { helper } : {}) });
  return [
    ...okIds, ...plain,
    ref("blank", "blank.png"), ref("truncated", "truncated.png"), ref("big", "big.png"), ref("huge", "huge.png"),
    ref("missing", "shot.png", join(stubs, "no-such-helper")),
    ref("timeout", "shot.png", printing({ ok: false, code: "timeout" })), ref("memory", "shot.png", printing({ ok: false, code: "memory" })),
    { id: "folder", kind: "folder", path: join(fx, "proj"), helper: md5Stub() },
  ];
}
const REFUSAL: Record<string, string> = { blank: "noText", truncated: "damaged", big: "bytes", huge: "pixels", missing: "missing", timeout: "timeout", memory: "memory" };

/** Child stand: ok lines are forwarded, the RESULT line is parsed. */
async function subStand(what: string, script: string, dataDir: string, lang: string, manifest: string) {
  mkdirSync(dataDir, { recursive: true });
  const r = proc(process.execPath, [join(repo, script), manifest, lang], { ...baseEnv, COUNCIL_LANG: lang, COUNCIL_HOME: dataDir });
  const code = await r.exited;
  const lines = r.out.split("\n");
  for (const l of lines) if (l && !l.startsWith("RESULT ")) console.log(l);
  if (code !== 0) throw new Error(`part "${what}" (${lang}) exited with code ${code}${r.err ? `\n${r.err}` : ""}`);
  const line = lines.find((l) => l.startsWith("RESULT "));
  assert.ok(line, `part "${what}" printed no RESULT`);
  const res = JSON.parse(line.slice(7)) as { checks: number; cases: Record<string, Outcome | { error: string }>; dataDir: string };
  checks += res.checks;
  return res;
}

const imageNeedles = (): [string, string][] => {
  // Slices of image bytes in the three encodings a leak could have: raw, base64 and JSON-escaped.
  const files = [...fmts.map((f) => join(fx, `shot.${f}`)), ...(webp ? [join(fx, "shot.webp")] : [])];
  return files.flatMap((f): [string, string][] => {
    const b = readFileSync(f), s = b.subarray(48, 48 + 63);
    return [[`${basename(f)} raw`, s.toString("latin1")], [`${basename(f)} base64`, s.toString("base64")], [`${basename(f)} escaped`, JSON.stringify(s.toString("utf8")).slice(1, -1)]];
  });
};

async function suite(lang: "ru" | "en") {
  const t = T[lang];
  setProcessLanguage(lang);
  const tag = `[${lang}]`;
  const cliHome = join(work, `cli-${lang}`), promptLog = join(work, `prompts-${lang}.jsonl`);
  mkdirSync(cliHome, { recursive: true });
  const cliEnv = (extra: Record<string, string> = {}) => ({ ...baseEnv, COUNCIL_LANG: lang, COUNCIL_HOME: cliHome, COUNCIL_SCRIPTED_PROMPT_LOG: promptLog, OPENAI_API_KEY: SECRET, STAND_SECRET: SECRET, ...extra });
  const run = async (args: string[], extra: Record<string, string> = {}) => { const r = proc(process.execPath, [entry, ...args], cliEnv(extra)); const code = await r.exited; return { code, r }; };
  const sdir = (id: string) => join(cliHome, "sessions", id);
  const events = (id: string) => readFileSync(join(sdir(id), "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
  const created = (id: string) => events(id).find((e) => e.type === "session_created")!.session;
  const journals = () => (existsSync(join(cliHome, "sessions")) ? readdirSync(join(cliHome, "sessions")).filter((d) => existsSync(join(cliHome, "sessions", d, "events.jsonl"))) : []);
  const sessionId = (r: Proc) => t.session.exec(r.out)?.[1] ?? assert.fail(`no session line${dump(r)}`);
  const promptLines = () => (existsSync(promptLog) ? readFileSync(promptLog, "utf8").split("\n").filter(Boolean) : []);
  const attach = (path: string, extra: Record<string, string> = {}, args: string[] = []) => run(["--topic", "Что на изображении?", "--attach", path, ...consensus, "--max-rounds", "3", ...args], extra);
  const base = (n: string) => basename(n);
  const outcome = (r: Proc): Outcome => {
    const id = sessionId(r), mats = created(id).materials as { id: string; name: string; chars: number; sha256: string }[];
    const skipped = r.out.split("\n").flatMap((l) => {
      const reason = Object.values(t.reason).find((x) => l.includes(x));
      const name = /[\w.-]+\.(?:png|jpe?g)/.exec(l)?.[0];
      return reason && name ? [{ name, reason }] : [];
    });
    return {
      items: mats.map((m) => ({ name: base(m.name), sha: m.sha256, chars: m.chars })),
      m1: readFileSync(join(sdir(id), "materials", `${mats[0]!.id}.txt`), "utf8"),
      skipped: skipped.sort((a, b) => a.name.localeCompare(b.name)),
    };
  };

  // ---- Cases through the terminal ----
  const all = cases();
  const manifest = join(work, `manifest-${lang}.json`);
  writeFileSync(manifest, JSON.stringify({ cases: all }));
  const cli: Record<string, Outcome> = {};
  const promptsBeforeAll = promptLines().length;
  const nBefore = journals().length;
  let accepted = 0, refused = 0;
  for (const c of all) {
    const extra: Record<string, string> = c.helper ? { COUNCIL_OCR_HELPER: c.helper } : {};
    if (c.kind === "refuse") {
      const sessions = journals().length, prompts = promptLines().length;
      const r = await attach(c.path, extra, ["--max-rounds", "1"]);
      const reason = t.reason[REFUSAL[c.id]!]!;
      assert.equal(r.code, 2, `${c.id}: code ${r.code}${dump(r.r)}`);
      assert.equal(r.r.out, "", `${c.id}: stdout${dump(r.r)}`);
      assert.equal(r.r.err, `${t.rejected}\n  «${basename(c.path)}»: ${reason}\n`, `${c.id}: stderr${dump(r.r)}`);
      assert.equal(journals().length, sessions, `${c.id}: a session appeared`);
      assert.equal(promptLines().length, prompts, `${c.id}: a participant was called`);
      refused++;
      continue;
    }
    const before = promptLines().length;
    const r = await attach(c.path, extra);
    assert.equal(r.code, 0, `${c.id}: code ${r.code}${dump(r.r)}`);
    const o = cli[c.id] = outcome(r.r);
    const fresh = promptLines().slice(before);
    assert.ok(fresh.length >= 2 && fresh.every((l) => (JSON.parse(l) as { prompt: string }).prompt.includes(o.m1)), `${c.id}: not every turn request carries the snapshot text`);
    assert.equal(o.items[0]!.sha, sha(Buffer.from(o.m1, "utf8")), `${c.id}: sha256 is not the text hash`);
    accepted++;
  }
  ok(`${tag} terminal: ${accepted} accepted cases (images and text look-alikes) with the text in every turn request; ${refused} explicit-file refusals with exit code 2, "${t.rejected}" and the exact reason, no session, no participant call`);

  // ---- 1 and 2. Formats, extension independence, text look-alikes ----
  for (const f of [...fmts, ...(webp ? ["webp"] : [])]) assertPhrases(cli[`shot.${f}`]!.m1, `shot.${f}`);
  ok(`${tag} 1: PNG, JPEG, TIFF, GIF, BMP, HEIC${webp ? ", WebP" : ""} give both phrases ("${LINES.join('", "')}") in order, sha256 is the hash of the snapshot text`);
  assert.equal(cli["photo.txt"]!.m1, cli["shot.jpeg"]!.m1);
  assert.equal(cli["scan.dat"]!.m1, cli["shot.png"]!.m1);
  assertPhrases(cli["photo.txt"]!.m1, "photo.txt");
  assert.equal(cli["bm.txt"]!.m1, readFileSync(join(fx, "bm.txt"), "utf8"));
  assert.equal(cli["ii.txt"]!.m1, readFileSync(join(fx, "ii.txt"), "utf8"));
  ok(`${tag} 2: a JPEG named photo.txt and a PNG named scan.dat are recognized (the text equals shot.jpeg / shot.png); text files starting with BM and II* stay text, byte for byte`);

  // ---- MCP and app parts: the same cases ----
  const mcp = await subStand("MCP", "packages/mcp/scenarios/ocr/check.ts", join(work, `mcp-${lang}`), lang, manifest);
  const desk = await subStand("app", "apps/desktop/scenarios/ocr/check.ts", join(work, `desktop-${lang}`), lang, manifest);
  for (const c of all) {
    if (c.kind === "refuse") {
      for (const [what, res] of [["MCP", mcp], ["app", desk]] as const) {
        const e = (res.cases[c.id] as { error: string }).error;
        assert.ok(e.includes(t.reason[REFUSAL[c.id]!]!), `${what} ${c.id}: error «${e}»`);
      }
    } else for (const [what, res] of [["MCP", mcp], ["app", desk]] as const) assert.deepEqual(res.cases[c.id], cli[c.id], `${what} ${c.id} differs from the terminal`);
  }
  ok(`${tag} parity: ${accepted} accepted cases give the same names, chars, sha256, snapshot text and skipped list in the terminal, MCP council_start and the app main modules; ${refused} refusals name the same reason in all three`);

  // ---- 5. Folder ----
  const f = cli.folder!;
  const names = f.items.map((i) => i.name);
  const expectedNames = ["README.md", ...Array.from({ length: OCR_LIMITS.folderImages }, (_, i) => `img-${String(i + 1).padStart(2, "0")}.png`)];
  assert.deepEqual([...names].sort(), expectedNames, "taken materials");
  assert.deepEqual(f.skipped, [{ name: "000-broken.png", reason: t.reason.damaged }, ...Array.from({ length: 10 }, (_, i) => ({ name: `img-${51 + i}.png`, reason: t.reason.folder }))].sort((a, b) => a.name.localeCompare(b.name)));
  ok(`${tag} 5: folder with README, a damaged image and 60 images (stub helper): README + the first 50 by name collected, "000-broken.png" skipped as "${t.reason.damaged}", the last 10 skipped with "${t.reason.folder}"; identical in the terminal, MCP and app`);
  if (lang === "ru") {
    const r = await attach(join(fx, "realproj"));
    assert.equal(r.code, 0, dump(r.r));
    const o = outcome(r.r);
    assert.deepEqual(o.items.map((i) => i.name).sort(), expectedNames);
    assert.equal(o.skipped.length, 11);
    const snap = readFileSync(join(sdir(sessionId(r.r)), "materials", `${created(sessionId(r.r)).materials.find((m: any) => base(m.name) === "img-07.png").id}.txt`), "utf8");
    assert.ok(norm(snap).includes("файл номер 7"), `img-07.png: ${JSON.stringify(snap)}`);
    ok("[ru] 5: the same folder with real pictures and the REAL helper in the terminal: 50 recognized (img-07.png reads «Файл номер 7»), 10 over the limit and the damaged one skipped");
  }

  // ---- 3. No image bytes; resume from the snapshot after the source is deleted ----
  const src = join(fx, `resume-${lang}.png`);
  copyFileSync(join(fx, "shot.png"), src);
  const steps = (name: string, list: { stance: string; solution?: string | null }[]) => {
    const p = join(work, `${name}.json`);
    writeFileSync(p, JSON.stringify({ steps: list.map((s) => ({ response: { stance: s.stance, reasoning: "Проверка изображений.", solution: s.solution ?? null, answers: [], questions: [], files: [] } })) }));
    return `scripted:${p}`;
  };
  const pairArgs = ["--participant", steps(`${lang}-rp1`, [{ stance: "amend", solution: "Решение." }, { stance: "object" }, { stance: "agree" }]), "--participant", steps(`${lang}-rp2`, [{ stance: "object" }, { stance: "object" }, { stance: "agree" }])];
  const r3 = await run(["--topic", "Что на изображении?", "--attach", src, ...pairArgs, "--max-rounds", "1"]);
  assert.equal(r3.code, 3, `no_consensus expected${dump(r3.r)}`);
  const sid = sessionId(r3.r), m1 = join(sdir(sid), "materials", "m1.txt"), snapText = readFileSync(m1, "utf8");
  assertPhrases(snapText, "resume session");
  rmSync(src);
  const beforeResume = promptLines().length;
  const r3b = await run(["resume", sid, "--rounds", "2"]);
  assert.equal(r3b.code, 0, `resume code ${r3b.code}${dump(r3b.r)}`);
  const fresh = promptLines().slice(beforeResume);
  assert.ok(fresh.length > 0 && fresh.every((l) => (JSON.parse(l) as { prompt: string }).prompt.includes(snapText)), "resume requests do not carry the snapshot text");
  assert.equal(readFileSync(m1, "utf8"), snapText, "m1.txt changed");
  ok(`${tag} 3: after the source image is deleted, council resume runs from the text snapshot (${fresh.length} requests carry the text), m1.txt unchanged`);

  // ---- 6. Isolation through a real council process ----
  const written = join(stubs, "written-by-helper.txt");
  rmSync(written, { force: true });
  const probe = stub([
    `A=$(/usr/bin/printf '%s\\n' "$0" "$@" | /usr/bin/base64 | /usr/bin/tr -d '\\n')`,
    `E=$(/usr/bin/env | /usr/bin/base64 | /usr/bin/tr -d '\\n')`,
    `D=$(/bin/pwd | /usr/bin/base64 | /usr/bin/tr -d '\\n')`,
    `U=$( { /usr/bin/curl -s -m 3 http://127.0.0.1:${port}/ 2>&1; echo "rc=$?"; } | /usr/bin/base64 | /usr/bin/tr -d '\\n')`,
    `W=$( { ( /bin/echo x > ${written} ) 2>&1; echo "rc=$?"; } | /usr/bin/base64 | /usr/bin/tr -d '\\n')`,
    `printf '{"ok":true,"lines":[{"t":"probe","x":0,"y":0.1,"w":0.5,"h":0.05},{"t":"ARGV %s","x":0,"y":0.2,"w":0.5,"h":0.05},{"t":"ENV %s","x":0,"y":0.3,"w":0.5,"h":0.05},{"t":"CURL %s","x":0,"y":0.4,"w":0.5,"h":0.05},{"t":"WRITE %s","x":0,"y":0.5,"w":0.5,"h":0.05},{"t":"PWD %s","x":0,"y":0.6,"w":0.5,"h":0.05}]}\\n' "$A" "$E" "$U" "$W" "$D"`,
  ].join("\n"));
  const probeImg = join(fx, "probe-source.png");
  copyFileSync(join(fx, "shot.png"), probeImg);
  const connBefore = connections;
  const r6 = await attach(probeImg, { COUNCIL_OCR_HELPER: probe });
  assert.equal(r6.code, 0, dump(r6.r));
  const probeText = outcome(r6.r).m1;
  const field = (k: string) => Buffer.from(new RegExp(`^${k} (\\S+)$`, "m").exec(probeText)?.[1] ?? assert.fail(`no ${k} in ${probeText}`), "base64").toString("utf8");
  const argv = field("ARGV").trimEnd().split("\n");
  assert.equal(argv.length, 2, `argv: ${argv}`);
  assert.equal(argv[1], JSON.stringify({ mode: "image", ms: OCR_LIMITS.ms, rssBytes: OCR_LIMITS.rssBytes }), "helper request");
  assert.ok(!argv.join("\n").includes(fx) && !argv.join("\n").includes("probe-source"), `a source path reached the helper: ${argv}`);
  const envKeys = field("ENV").split("\n").filter(Boolean).map((l) => l.split("=")[0]!).filter((k) => !["__CF_USER_TEXT_ENCODING", "PWD", "SHLVL", "_"].includes(k)); // macOS and /bin/sh add these themselves
  assert.deepEqual(envKeys, [], `the helper saw variables: ${envKeys}`);
  assert.ok(!field("ENV").includes(SECRET), "the control secret reached the helper");
  assert.equal(field("PWD").trim(), "/", "working directory");
  assert.ok(!/rc=0\s*$/.test(field("CURL")), `curl succeeded: ${field("CURL")}`);
  assert.ok(!/rc=0\s*$/.test(field("WRITE")), `write succeeded: ${field("WRITE")}`);
  assert.ok(!existsSync(written), "the helper wrote a file");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(connections, connBefore, `the local server got ${connections - connBefore} connections from the helper`);
  ok(`${tag} 6: a stub helper trying curl to a local HTTP server and a file write is denied (server saw 0 connections, no file); it saw no environment variables (STAND_SECRET, OPENAI_API_KEY set in the parent), cwd "/", argv = its own path + the limits JSON, no source path`);

  // ---- 3 (bytes). No image bytes anywhere ----
  const needles = imageNeedles();
  const zone = [...allFiles(work).filter((p) => !p.startsWith(fx) && !p.startsWith(stubs) && !p.endsWith("manifest-ru.json") && !p.endsWith("manifest-en.json")).map((p) => [p, readFileSync(p, "latin1")] as const), ...captured.map((c, i) => [`output ${i}`, c] as const)];
  for (const [where, text] of zone) {
    for (const [what, needle] of needles) assert.ok(!text.includes(needle), `${what} found in ${where}`);
    assert.ok(!text.includes("\x89PNG") && !text.includes("IHDR"), `PNG bytes in ${where}`);
  }
  assert.equal(journals().length > nBefore, true);
  ok(`${tag} 3: no PNG signature and no 63-byte image slice (raw, base64, JSON-escaped) in ${zone.length} stand files and outputs (journals, snapshots, prompt logs, stdout, stderr)`);
  void promptsBeforeAll;
}

async function inProcess() {
  setProcessLanguage("en");
  // ---- 4. Supervision by the real helper and the parent fallback ----
  const img = makeImage("png", ["Договор поставки", "Срок оплаты", "Договор поставки", "Срок оплаты"], { width: 2400, height: 1200 });
  setOcrRuntime({ helper: REAL });
  try {
    const good = runOcrHelper({ mode: "image", ms: OCR_LIMITS.ms, rssBytes: OCR_LIMITS.rssBytes }, img);
    assert.ok(good.ok, `the real helper does not recognize: ${JSON.stringify(good)}`);
    const mem = runOcrHelper({ mode: "image", ms: OCR_LIMITS.ms, rssBytes: 1_000_000 }, img);
    assert.deepEqual(mem, { ok: false, code: "memory" }, "rssBytes 1 MB");
    const slow = runOcrHelper({ mode: "image", ms: 1, rssBytes: OCR_LIMITS.rssBytes }, img);
    assert.deepEqual(slow, { ok: false, code: "timeout" }, "ms 1");
    ok("4: the REAL helper stops itself: rssBytes 1000000 -> memory, ms 1 -> timeout (same input recognized with the real limits)");
    setOcrRuntime({ helper: hangStub() });
    const t0 = Date.now();
    const hang = runOcrHelper({ mode: "image", ms: 500, rssBytes: OCR_LIMITS.rssBytes }, img);
    const took = Date.now() - t0;
    assert.deepEqual(hang, { ok: false, code: "timeout" });
    assert.ok(took >= 2000 && took < 8000, `the parent fallback fired after ${took} ms (expected about ms + 2000)`);
    ok(`4: a hanging stub is killed by the parent after ms + 2 s (${took} ms) and reported as timeout`);
  } finally { setOcrRuntime(); }
}

async function main() {
  server = net.createServer((s) => { connections++; s.destroy(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as net.AddressInfo).port;
  try { webp = await chromeWebp(); } catch (e) { console.log(`WebP recognition: NOT VERIFIED (Chrome failed: ${e instanceof Error ? e.message : String(e)})`); }
  if (!existsSync(CHROME)) console.log("WebP recognition: NOT VERIFIED (no Chrome)");
  buildFixtures();
  const srcBefore = Object.fromEntries(allFiles(fx).filter((p) => !p.includes("/proj/") && !p.includes("/realproj/")).map((p) => [p, sha(readFileSync(p))]));
  for (const lang of ["ru", "en"] as const) await suite(lang);
  await inProcess();
  for (const [p, h] of Object.entries(srcBefore)) if (existsSync(p)) assert.equal(sha(readFileSync(p)), h, `${p} changed`);
  ok("source images are byte-identical after all parts");
  assert.ok(!allFiles(work).filter((p) => !p.startsWith(fx)).some((p) => readFileSync(p, "latin1").includes(SECRET)), "the control secret value was found in the stand files");
  ok("the control secret value is absent from journals, snapshots and logs");
  console.log("note: 0 real model calls — every part uses scripted participants only");
  server.close();
}

let failed = false;
const guard = setTimeout(() => { console.error(`FAILED: the stand did not finish within 900 seconds\nStand left in place: ${work}`); for (const k of kids) k.kill("SIGKILL"); process.exit(1); }, 900000);
try {
  await main();
  console.log(`ocr stand: PASS (${checks} checks)`);
} catch (e) {
  failed = true;
  console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}\nStand left in place: ${work}`);
} finally {
  clearTimeout(guard);
  for (const k of kids) k.kill("SIGKILL");
}
if (!failed) rmSync(work, { recursive: true, force: true });
console.log(`run time: ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(failed ? 1 : 0);

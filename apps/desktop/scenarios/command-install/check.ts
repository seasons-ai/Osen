// `council` terminal command install (~/.local/bin/council -> <Osen.app>/Contents/Resources/bin/council) on a fake HOME with the real zsh.
//   COUNCIL_DEV=1 node apps/desktop/scenarios/command-install/check.ts [--app <path to Osen.app>]
// Needs a packaged app (npm run dist): the wrapper is only pointed at, the bundle is not copied. The real HOME and shell files are never touched.
// The sequence runs twice (en, then ru). Models are not called. The stand folder is removed on success and kept on failure.
import "../../../../packages/core/scenarios/language-ru.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Language } from "@model-council/core/i18n";
import { classifyLink, commandStatus, describeState, installCommand, LINK_HINT_LINE, removeCommand, type CommandOptions } from "../../src/main/command-install.ts";

const root = resolve(import.meta.dirname, "../../../..");
const argApp = process.argv.indexOf("--app");
const app = resolve(argApp > 0 ? process.argv[argApp + 1]! : join(root, "apps/desktop/release.noindex/mac-arm64/Osen.app"));
const wrapper = join(app, "Contents/Resources/bin/council");

let failed = false;
const report = (ok: boolean, text: string) => {
  if (!ok) failed = true;
  console.log(`${ok ? "OK  " : "FAIL"} ${text}`);
};

if (!existsSync(wrapper)) {
  console.log(`FAIL no ${wrapper} - run npm run dist first (or pass --app <path to Osen.app>)`);
  process.exit(1);
}

// zsh fails to open $ZDOTDIR/.zprofile under some non-ASCII paths (this project's folder gives "bad pattern"), so the stand needs an ASCII-only base:
// COUNCIL_HOME if it is ASCII, else .council-data under the project if ASCII, else the system temp folder.
const ascii = (p: string) => /^[\x20-\x7e]+$/.test(p);
const base = [process.env.COUNCIL_HOME && resolve(process.env.COUNCIL_HOME), join(root, ".council-data"), tmpdir()].find((p) => p && ascii(p))!;
mkdirSync(base, { recursive: true });
const stand = mkdtempSync(join(base, "command-install-"));

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const snapshot = (dir: string) => readdirSync(dir).sort().map((n) => {
  const p = join(dir, n);
  const st = lstatSync(p);
  return `${n}|${st.isSymbolicLink() ? readlinkSync(p) : ""}|${st.mtimeMs}`;
});
const script = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

const refusals: Record<string, { code: string; path: string }> = {};

async function run(language: Language) {
  const tag = `[${language}]`;
  const dir = join(stand, language);
  let n = 0;
  // fresh fake HOME per use; ZDOTDIR = HOME so the stand .zprofile is the only user shell file
  const freshHome = () => {
    const h = join(dir, `home${n++}`);
    mkdirSync(h, { recursive: true });
    return h;
  };
  const envFor = (home: string) => ({ HOME: home, ZDOTDIR: home, PATH: "/usr/bin:/bin", LANG: process.env.LANG ?? "en_US.UTF-8", TERM: process.env.TERM ?? "xterm" });
  const opts = (home: string, extra: Partial<CommandOptions> = {}): CommandOptions => ({ home, wrapper, env: envFor(home), shell: "/bin/zsh", language, ...extra });
  const profile = (home: string, line: string) => writeFileSync(join(home, ".zprofile"), `${line}\n`);

  const home = freshHome();
  const link = join(home, ".local/bin/council");
  const o = opts(home);

  // (a) install on empty HOME
  profile(home, 'export PATH="/usr/bin:/bin"');
  const a = await installCommand(o);
  report(a.ok && a.changed && readlinkSync(link) === wrapper, `${tag} (a) install creates the link to the wrapper`);

  // (b) ~/.local/bin not in PATH
  const before = sha(join(home, ".zprofile"));
  const b = await commandStatus(o);
  console.log(`     ${describeState(b, language)}`);
  report(b.state === "not_in_path" && b.hint.line === LINK_HINT_LINE && LINK_HINT_LINE === 'export PATH="$HOME/.local/bin:$PATH"', `${tag} (b) not_in_path with the exact hint line`);
  report(sha(join(home, ".zprofile")) === before, `${tag} (b) .zprofile is unchanged`);

  // (c) in PATH, no node: found and the command runs
  profile(home, 'export PATH="$HOME/.local/bin:/usr/bin:/bin"');
  const c = await commandStatus(o);
  console.log(`     ${describeState(c, language)}`);
  report(c.state === "found", `${tag} (c) status found`);
  let out = "";
  try {
    out = execFileSync("/bin/zsh", ["-ilc", "command -v council; command -v node || echo NO_NODE; council --help"], { env: envFor(home), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  } catch (e) {
    out = String(e);
  }
  report(out.includes(link) && out.includes("NO_NODE") && out.includes("council --topic"), `${tag} (c) new login shell resolves council to the link, no node in PATH, help is printed`);

  // (d) idempotent install
  const snap = snapshot(join(home, ".local/bin"));
  const d = await installCommand(o);
  report(d.ok && !d.changed && !d.updated && JSON.stringify(snapshot(join(home, ".local/bin"))) === JSON.stringify(snap), `${tag} (d) second install changes nothing`);

  // (e) foreign objects are never overwritten
  rmSync(link);
  writeFileSync(link, "my own file\n");
  const e1 = await installCommand(o);
  if (!e1.ok) { console.log(`     ${e1.message}`); refusals[language] = { code: e1.code, path: e1.path }; }
  report(!e1.ok && e1.code === "foreign" && readFileSync(link, "utf8") === "my own file\n", `${tag} (e) regular file: refused foreign, content unchanged`);
  rmSync(link);
  symlinkSync("/usr/local/bin/other-council", link);
  const e2 = await installCommand(o);
  report(!e2.ok && e2.code === "foreign" && readlinkSync(link) === "/usr/local/bin/other-council", `${tag} (e) foreign symlink: refused, target unchanged`);
  rmSync(link);
  await installCommand(o);

  // (e2) a foreign object appears after the check, before the link is created: refused, never deleted
  const raceHome = freshHome();
  const raceLink = join(raceHome, ".local/bin/council");
  const race1 = await installCommand(opts(raceHome, { symlink: (t, p) => { writeFileSync(p, "raced file\n"); symlinkSync(t, p); } }));
  report(!race1.ok && race1.code === "foreign" && race1.path === raceLink && !!race1.detail && readFileSync(raceLink, "utf8") === "raced file\n", `${tag} (e2) foreign file appearing before link creation: refused foreign with path and kind, content unchanged`);
  rmSync(raceLink);
  const race2 = await installCommand(opts(raceHome, { symlink: (t, p) => { symlinkSync("/usr/local/bin/other-council", p); symlinkSync(t, p); } }));
  report(!race2.ok && race2.code === "foreign" && race2.path === raceLink && !!race2.detail && readlinkSync(raceLink) === "/usr/local/bin/other-council", `${tag} (e2) foreign symlink appearing before link creation: refused foreign with path and kind, target unchanged`);

  // (f) shadowed by an earlier PATH entry
  const shadow = join(dir, "shadow");
  script(join(shadow, "council"), "echo shadow");
  profile(home, `export PATH="${shadow}:$HOME/.local/bin:/usr/bin:/bin"`);
  const f = await commandStatus(o);
  console.log(`     ${describeState(f, language)}`);
  report(f.state === "shadowed" && f.shadowedBy === join(shadow, "council"), `${tag} (f) shadowed by ${shadow}/council`);
  profile(home, 'export PATH="$HOME/.local/bin:/usr/bin:/bin"');

  // (g) stale path after the app was moved
  rmSync(link);
  const moved = join(dir, "moved/Osen.app/Contents/Resources/bin/council");
  symlinkSync(moved, link);
  const g = await commandStatus(o);
  console.log(`     ${describeState(g, language)}`);
  report(g.state === "stale", `${tag} (g) link to a moved app is stale`);
  const g2 = await installCommand(o);
  report(g2.ok && g2.updated && readlinkSync(link) === wrapper, `${tag} (g) install updates the link`);

  // (h) shell that does not answer: never not_in_path, link untouched
  for (const [name, body, ms] of [["sleep", "sleep 30", 1000], ["exit3", "exit 3", 5000]] as const) {
    const stub = join(dir, `stub-${name}`);
    script(stub, body);
    const s = await commandStatus(opts(home, { shell: stub, timeoutMs: ms }));
    console.log(`     ${describeState(s, language)}`);
    report(s.state === "check_failed" && readlinkSync(link) === wrapper, `${tag} (h) shell "${name}": check_failed, link unchanged`);
  }
  const h2home = freshHome();
  const h2 = await installCommand(opts(h2home, { wrapper: join(dir, "nowhere/council") }));
  if (!h2.ok) console.log(`     ${h2.message}`);
  report(!h2.ok && h2.code === "no_wrapper" && !existsSync(join(h2home, ".local")), `${tag} (h) missing wrapper: refused no_wrapper, ~/.local/bin not created`);

  // (i) remove touches only the own link
  const sibling = join(home, ".local/bin/other-tool");
  writeFileSync(sibling, "x");
  const r = removeCommand(o);
  const rs = await commandStatus(o);
  report(r.ok && r.removed && !existsSync(link) && existsSync(sibling) && existsSync(join(home, ".local/bin")) && rs.state === "not_installed", `${tag} (i) remove deletes only the link, sibling and dir stay, status not_installed`);
  writeFileSync(link, "foreign\n");
  const r2 = removeCommand(o);
  report(!r2.ok && r2.code === "foreign" && existsSync(link), `${tag} (i) remove refuses a foreign object`);
  void classifyLink;
}

try {
  for (const l of ["en", "ru"] as const) await run(l);
  const { en, ru } = refusals;
  report(!!en && !!ru && en.code === ru.code && en.path.slice(en.path.indexOf("/en/") + 4) === ru.path.slice(ru.path.indexOf("/ru/") + 4), "foreign refusal code and path match across en and ru");
} catch (e) {
  report(false, `check not performed: ${e instanceof Error ? e.stack : String(e)}`);
}
if (!failed) rmSync(stand, { recursive: true, force: true });
console.log(failed ? `CHECK FAILED (stand kept: ${stand})` : "ALL CHECKS PASSED");
process.exit(failed ? 1 : 0);

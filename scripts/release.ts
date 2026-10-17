// Release: checks, new version in apps/desktop/package.json, CHANGELOG.md section, commit and vX.Y.Z tag.
// npm run release -- [patch|minor|major|X.Y.Z] [--dry-run]; without a level it is derived from the commits.
// node scripts/release.ts check-msg <file> — commit message check (commit-msg hook).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const TYPES = "feat|fix|perf|refactor|docs|test|build|ci|chore|style|revert";
const HEADER = new RegExp(`^(${TYPES})(?:\\(([^()\\s]+)\\))?(!)?: (\\S.*)$`);
const AUTO = /^(Merge |Revert "|fixup! |squash! |amend! )/;
const SECTIONS = [
  ["breaking", "Breaking changes"],
  ["feat", "Added"],
  ["fix", "Fixed"],
  ["perf", "Performance"],
] as const;

export type Commit = { hash: string; subject: string; body: string };
export type Parsed = { type: string; scope?: string; breaking: boolean; text: string; hash: string };
export type Level = "major" | "minor" | "patch";

export function parse(c: Commit): Parsed | null {
  const m = HEADER.exec(c.subject);
  if (!m) return null;
  return { type: m[1], scope: m[2], breaking: !!m[3] || /^BREAKING[ -]CHANGE: /m.test(c.body), text: m[4], hash: c.hash };
}

export function checkMessage(msg: string): string | null {
  const subject = msg.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";
  if (HEADER.test(subject) || AUTO.test(subject)) return null;
  return [
    `Commit message does not match the format: "${subject}"`,
    "Expected: type(scope): description   — Conventional Commits",
    `Types: ${TYPES.replaceAll("|", ", ")}. Scope is a change number or a part of the code; it may be omitted.`,
    "Breaking change: \"!\" before the colon or a \"BREAKING CHANGE: …\" line in the body.",
    "Example: feat(120-history-search): search across session history",
  ].join("\n");
}

export function levelOf(commits: Parsed[]): Level | null {
  if (commits.some((c) => c.breaking)) return "major";
  if (commits.some((c) => c.type === "feat")) return "minor";
  if (commits.some((c) => c.type === "fix" || c.type === "perf")) return "patch";
  return null;
}

export function bump(version: string, to: string): string {
  const v = version.split(".").map(Number);
  if (to === "major") return `${v[0] + 1}.0.0`;
  if (to === "minor") return `${v[0]}.${v[1] + 1}.0`;
  if (to === "patch") return `${v[0]}.${v[1]}.${v[2] + 1}`;
  if (!/^\d+\.\d+\.\d+$/.test(to)) throw new Error(`Neither a version nor a level: ${to}`);
  const n = to.split(".").map(Number);
  const i = n.findIndex((x, k) => x !== v[k]);
  if (i < 0 || n[i] < v[i]) throw new Error(`${to} is not greater than the current ${version}`);
  return to;
}

export function section(version: string, date: string, commits: Parsed[]): string {
  const out = [`## [${version}] — ${date}`];
  for (const [key, title] of SECTIONS) {
    const items = commits.filter((c) => (key === "breaking" ? c.breaking : !c.breaking && c.type === key));
    if (!items.length) continue;
    out.push("", `### ${title}`, "");
    for (const c of items) out.push(`- ${c.scope ? `**${c.scope}**: ` : ""}${c.text} (${c.hash})`);
  }
  if (out.length === 1) out.push("", "No user-facing changes.");
  return out.join("\n") + "\n";
}

export function insertSection(changelog: string, sec: string): string {
  const at = changelog.search(/^## \[/m);
  return at < 0 ? `${changelog.trimEnd()}\n\n${sec}` : `${changelog.slice(0, at)}${sec}\n${changelog.slice(at)}`;
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const fail = (msg: string): never => { console.error(msg); process.exit(1); };

function release(args: string[]) {
  const dry = args.includes("--dry-run");
  const want = args.find((a) => !a.startsWith("--"));
  if (git("branch", "--show-current") !== "main") fail("A release is made only from the main branch.");
  if (!dry && git("status", "--porcelain")) fail("The working tree has uncommitted changes: commit or discard them first.");

  const last = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*");
  const raw = git("log", "--format=%h%x1f%s%x1f%b%x1e", `${last}..HEAD`);
  const commits = raw.split("\x1e").map((r) => r.trim()).filter(Boolean)
    .map((r) => { const [hash, subject, body] = r.split("\x1f"); return { hash, subject, body: body ?? "" }; });
  if (!commits.length) fail(`No commits after ${last} — nothing to release.`);
  const parsed = commits.map(parse).filter((c): c is Parsed => !!c);

  const pkgPath = "apps/desktop/package.json";
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (`v${pkg.version}` !== last) fail(`The version in ${pkgPath} (${pkg.version}) does not match the last tag ${last}.`);
  const level = want ?? levelOf(parsed) ?? fail(`No feat, fix, perf or breaking commits after ${last}: specify the level explicitly (patch, minor, major).`);
  const next = bump(pkg.version, level);
  const sec = section(next, new Date().toLocaleDateString("sv"), parsed);

  console.log(`${last} → v${next}: commits: ${commits.length}, matching the format: ${parsed.length}\n\n${sec}`);
  if (dry) return console.log("--dry-run: nothing written.");

  for (const script of ["typecheck", "test"]) execFileSync("npm", ["run", script], { stdio: "inherit" });

  pkg.version = next;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  lock.packages["apps/desktop"].version = next;
  writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  writeFileSync("CHANGELOG.md", insertSection(readFileSync("CHANGELOG.md", "utf8"), sec));

  git("add", pkgPath, "package-lock.json", "CHANGELOG.md");
  git("commit", "-m", `chore(release): v${next}`);
  git("tag", "-a", `v${next}`, "-m", `Osen ${next}\n\n${sec}`);
  console.log(`Done: commit and tag v${next}. Next, the image: npm run dist && npm run dist:check (docs/deploy.md, "Update").`);
  if (git("remote")) console.log("To publish: git push --follow-tags");
}

if (import.meta.main) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd === "check-msg") {
    const err = checkMessage(readFileSync(file, "utf8"));
    if (err) fail(err);
  } else release(process.argv.slice(2));
}

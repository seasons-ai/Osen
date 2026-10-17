// Prepare a release PR; publish tags only after its squash merge on synchronized main.
// npm run release -- [patch|minor|major|X.Y.Z] [--dry-run]; without a level it is derived from the commits.
// npm run release -- publish; verify-tag checks a tag in CI; check-msg <file> serves the commit hook.
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

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const fail = (msg: string): never => { throw new Error(msg); };
const PKG = "apps/desktop/package.json";
const LOCK = "package-lock.json";
const VERSION = /^\d+\.\d+\.\d+$/;

function synchronizedMain() {
  if (git("branch", "--show-current") !== "main") fail("A release is made only from the main branch.");
  if (git("status", "--porcelain")) fail("The working tree has uncommitted changes: commit or discard them first.");
  git("fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) fail("main must equal origin/main. Synchronize main before releasing.");
}

export function releaseNotes(changelog: string, version: string): string {
  const first = /^## \[([^\]]+)\].*$/m.exec(changelog);
  if (first?.[1] !== version) fail(`The first CHANGELOG.md section must be [${version}].`);
  const start = first.index + first[0].length;
  const rest = changelog.slice(start);
  const next = rest.search(/^## \[/m);
  const notes = (next < 0 ? rest : rest.slice(0, next)).trim();
  if (!notes) fail(`CHANGELOG.md has no notes for ${version}.`);
  return notes;
}

function releaseVersion(ref = "HEAD") {
  const version: string = JSON.parse(git("show", `${ref}:${PKG}`)).version;
  if (!VERSION.test(version)) fail(`Invalid desktop version: ${version}`);
  const lock = JSON.parse(git("show", `${ref}:${LOCK}`));
  if (lock.packages?.["apps/desktop"]?.version !== version) fail("The desktop version and package-lock.json do not match.");
  return version;
}

function releaseSubject(subject: string, version: string) {
  return subject.replace(/ \(#\d+\)$/, "") === `chore(release): v${version}`;
}

function mergedRelease(ref = "HEAD") {
  const version = releaseVersion(ref);
  if (!releaseSubject(git("log", "-1", "--format=%s", ref), version)) fail(`${ref} must be the merged chore(release): v${version} commit.`);
  const previous: string = JSON.parse(git("show", `${ref}^:${PKG}`)).version;
  bump(previous, version);
  const paths = git("diff-tree", "--no-commit-id", "--name-only", "-r", ref).split("\n").sort();
  if (paths.join("\n") !== [PKG, LOCK, "CHANGELOG.md"].sort().join("\n")) fail("The release commit must change only the desktop version, lockfile and CHANGELOG.md.");
  return { version, notes: releaseNotes(git("show", `${ref}:CHANGELOG.md`), version) };
}

function verifyTag(tag: string, ref = "HEAD") {
  const { version, notes } = mergedRelease(ref);
  if (tag !== `v${version}`) fail(`Tag ${tag} does not match version ${version}.`);
  if (git("cat-file", "-t", `refs/tags/${tag}`) !== "tag") fail(`Tag ${tag} must be annotated.`);
  if (git("rev-parse", `${tag}^{}`) !== git("rev-parse", ref)) fail(`Tag ${tag} must point to ${ref}.`);
  git("merge-base", "--is-ancestor", ref, "origin/main");
  return notes;
}

function publish(args: string[]) {
  if (args.length) fail("Usage: npm run release -- publish");
  synchronizedMain();
  const current = releaseVersion();
  const entry = git("log", "--first-parent", "--format=%H%x1f%s").split("\n")
    .find((line) => releaseSubject(line.split("\x1f")[1], current));
  if (!entry) fail(`main has no merged chore(release): v${current} commit.`);
  const ref = entry.split("\x1f")[0];
  const { version, notes } = mergedRelease(ref);
  if (version !== current) fail("The merged release version does not match the current desktop version.");
  const tag = `v${version}`;
  const existing = git("tag", "--list", tag);
  const remote = git("ls-remote", "--tags", "origin", `refs/tags/${tag}`);
  if (remote && (!existing || remote.split(/\s+/)[0] !== git("rev-parse", `refs/tags/${tag}`))) fail(`Remote tag ${tag} already exists with a different tag object; it will not be replaced.`);
  if (!existing) git("tag", "-a", tag, ref, "-m", `Osen ${version}\n\n${notes}`);
  verifyTag(tag, ref);
  // Push one tag so unrelated historical local tags stay private. Retrying a failed push is safe.
  execFileSync("git", ["push", "origin", `refs/tags/${tag}:refs/tags/${tag}`], { stdio: ["ignore", "inherit", "inherit"] });
  console.log(`Published ${tag}. GitHub Actions will build a draft release for review.`);
}

function release(args: string[]) {
  const dry = args.includes("--dry-run");
  const levels = args.filter((a) => a !== "--dry-run");
  if (levels.length > 1 || levels.some((a) => a.startsWith("--"))) fail("Usage: npm run release -- [patch|minor|major|X.Y.Z] [--dry-run]");
  synchronizedMain();
  const version = releaseVersion();
  const tags = git("tag", "--merged", "HEAD", "--sort=-version:refname").split("\n").filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  let last = tags[0];
  if (last && last !== `v${version}`) fail(`The desktop version ${version} does not match reachable tag ${last}.`);
  if (!last) {
    const roots = git("rev-list", "--max-parents=0", "HEAD").split("\n");
    if (roots.length !== 1 || JSON.parse(git("show", `${roots[0]}:${PKG}`)).version !== version) fail("Without a reachable version tag, the public root version must match the current desktop version.");
    last = roots[0];
  }
  const raw = git("log", "--format=%h%x1f%s%x1f%b%x1e", `${last}..HEAD`);
  const commits = raw.split("\x1e").map((r) => r.trim()).filter(Boolean)
    .map((r) => { const [hash, subject, body] = r.split("\x1f"); return { hash, subject, body: body ?? "" }; });
  if (!commits.length) fail(`No commits after ${last} — nothing to release.`);
  const parsed = commits.map(parse).filter((c): c is Parsed => !!c);
  const level = levels[0] ?? levelOf(parsed) ?? fail(`No feat, fix, perf or breaking commits after ${last}: specify patch, minor or major explicitly.`);
  const next = bump(version, level);
  const sec = section(next, new Date().toISOString().slice(0, 10), parsed);
  const branch = `codex/release-v${next}`;
  if (git("branch", "--list", branch)) fail(`Branch ${branch} already exists. Continue its PR instead of preparing it again.`);
  if (git("tag", "--list", `v${next}`) || git("ls-remote", "--tags", "origin", `refs/tags/v${next}`)) fail(`Tag v${next} already exists; it will not be replaced.`);
  console.log(`v${version} → v${next}: commits: ${commits.length}, matching the format: ${parsed.length}\n\n${sec}`);
  if (dry) return console.log("--dry-run: nothing written; origin/main was refreshed.");

  execFileSync("npm", ["run", "typecheck"], { stdio: ["ignore", "inherit", "inherit"], timeout: 15 * 60_000 });
  execFileSync("npm", ["test", "--", "--maxWorkers=4"], { stdio: ["ignore", "inherit", "inherit"], timeout: 15 * 60_000 });
  synchronizedMain();
  git("switch", "-c", branch);
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  pkg.version = next;
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");
  const lock = JSON.parse(readFileSync(LOCK, "utf8"));
  lock.packages["apps/desktop"].version = next;
  writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");
  writeFileSync("CHANGELOG.md", insertSection(readFileSync("CHANGELOG.md", "utf8"), sec));
  git("add", PKG, LOCK, "CHANGELOG.md");
  git("commit", "-m", `chore(release): v${next}`);
  console.log(`Prepared ${branch}; no tag was created.\nNext: git push -u origin ${branch}\nOpen a PR titled "chore(release): v${next}" and squash merge it after CI passes.\nThen synchronize main and run: npm run release -- publish`);
}

if (import.meta.main) {
  try {
    const [cmd, ...args] = process.argv.slice(2);
    if (cmd === "check-msg") {
      const err = checkMessage(readFileSync(args[0], "utf8"));
      if (err) fail(err);
    } else if (cmd === "publish") publish(args);
    else if (cmd === "verify-tag") {
      if (args.length !== 1 || !/^v\d+\.\d+\.\d+$/.test(args[0])) fail("Usage: node scripts/release.ts verify-tag vX.Y.Z");
      console.log(verifyTag(args[0]));
    } else release(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("scripts/release.ts");
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function repository() {
  const dir = mkdtempSync(join(tmpdir(), "osen-release-"));
  temporary.push(dir);
  const cwd = join(dir, "work");
  const remote = join(dir, "remote.git");
  mkdirSync(cwd);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--bare", remote);
  git("init", "-b", "main");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.invalid");
  mkdirSync(join(cwd, "apps/desktop"), { recursive: true });
  writeFileSync(join(cwd, "apps/desktop/package.json"), JSON.stringify({ version: "0.9.0" }, null, 2) + "\n");
  writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ packages: { "apps/desktop": { version: "0.9.0" } } }, null, 2) + "\n");
  writeFileSync(join(cwd, "CHANGELOG.md"), "# Changelog\n\n## [0.9.0] — 2026-10-16\n\nInitial release.\n");
  git("add", ".");
  git("commit", "-m", "chore: public root");
  git("remote", "add", "origin", remote);
  git("push", "-u", "origin", "main");
  const commit = (subject = "fix(120-github-delivery): repair release workflow") => {
    writeFileSync(join(cwd, "feature.txt"), `${subject}\n`);
    git("add", ".");
    git("commit", "-m", subject);
  };
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
    return { code: result.status, output: `${result.stdout}${result.stderr}` };
  };
  const prepare = () => {
    commit();
    git("push", "origin", "main");
    const result = run();
    expect(result, result.output).toMatchObject({ code: 0 });
  };
  const merge = (subject = "chore(release): v0.9.1 (#123)") => {
    git("switch", "main");
    git("merge", "--squash", "codex/release-v0.9.1");
    git("commit", "-m", subject);
    git("push", "origin", "main");
  };
  return { cwd, git, run, commit, prepare, merge };
}

describe("release delivery with a real local bare remote", { timeout: 30000 }, () => {
  it("prepares a PR branch, squash merges and publishes only its annotated tag, including retry", () => {
    const r = repository();
    const old = r.git("commit-tree", "HEAD^{tree}", "-m", "chore: unrelated old history");
    r.git("tag", "-a", "v0.8.0", old, "-m", "Old local release");
    r.prepare();
    expect(r.git("branch", "--show-current")).toBe("codex/release-v0.9.1");
    expect(r.git("tag", "--list")).toBe("v0.8.0");
    expect(r.git("show", "main:apps/desktop/package.json")).toContain('"0.9.0"');
    expect(r.git("log", "-1", "--format=%s")).toBe("chore(release): v0.9.1");
    r.merge();
    expect(r.run("publish")).toMatchObject({ code: 0 });
    expect(r.git("cat-file", "-t", "v0.9.1")).toBe("tag");
    expect(r.git("rev-parse", "v0.9.1^{}")).toBe(r.git("rev-parse", "HEAD"));
    expect(r.git("ls-remote", "--tags", "origin")).not.toContain("v0.8.0");
    expect(r.run("publish")).toMatchObject({ code: 0 });
  });

  it("previews without changing branch, files or tags", () => {
    const r = repository();
    r.commit();
    r.git("push", "origin", "main");
    const before = r.git("rev-parse", "HEAD");
    expect(r.run("--dry-run")).toMatchObject({ code: 0 });
    expect(r.git("branch", "--show-current")).toBe("main");
    expect(r.git("rev-parse", "HEAD")).toBe(before);
    expect(r.git("status", "--porcelain")).toBe("");
    expect(r.git("tag", "--list")).toBe("");
  });

  it("refuses dirty dry runs and main ahead of origin", () => {
    const r = repository();
    writeFileSync(join(r.cwd, "untracked.txt"), "draft");
    expect(r.run("--dry-run")).toMatchObject({ code: 1, output: expect.stringContaining("uncommitted") });
    rmSync(join(r.cwd, "untracked.txt"));
    r.commit();
    expect(r.run()).toMatchObject({ code: 1, output: expect.stringContaining("must equal origin/main") });
    expect(r.git("branch", "--show-current")).toBe("main");
  });

  it("fetches origin before refusing main behind its remote", () => {
    const r = repository();
    r.commit();
    r.git("push", "origin", "HEAD:refs/heads/advance");
    r.git("--git-dir", join(r.cwd, "../remote.git"), "update-ref", "refs/heads/main", r.git("rev-parse", "HEAD"));
    r.git("switch", "-c", "stale", "HEAD~1");
    r.git("branch", "-f", "main", "HEAD");
    r.git("switch", "main");
    expect(r.run("--dry-run")).toMatchObject({ code: 1, output: expect.stringContaining("must equal origin/main") });
    expect(r.git("rev-parse", "origin/main")).not.toBe(r.git("rev-parse", "main"));
  });

  it("refuses publishing before merge, and mismatched lock or changelog on merged main", () => {
    const r = repository();
    r.prepare();
    expect(r.run("publish")).toMatchObject({ code: 1, output: expect.stringContaining("only from the main branch") });
    r.merge();
    for (const file of ["package-lock.json", "CHANGELOG.md"]) {
      const path = join(r.cwd, file);
      const original = readFileSync(path, "utf8");
      writeFileSync(path, original.replaceAll("0.9.1", "0.9.2"));
      r.git("add", file);
      r.git("commit", "--amend", "--no-edit");
      r.git("push", "origin", `HEAD:refs/heads/invalid-${file.replaceAll(".", "-")}`);
      r.git("--git-dir", join(r.cwd, "../remote.git"), "update-ref", "refs/heads/main", r.git("rev-parse", "HEAD"));
      r.git("update-ref", "refs/remotes/origin/main", r.git("rev-parse", "HEAD"));
      expect(r.run("publish")).toMatchObject({ code: 1, output: expect.stringContaining(file) });
      writeFileSync(path, original);
      r.git("add", file);
      r.git("commit", "--amend", "--no-edit");
    }
    expect(r.git("tag", "--list")).toBe("");
  });

  it("refuses a lightweight or conflicting existing tag", () => {
    const r = repository();
    r.prepare();
    r.merge();
    r.git("tag", "v0.9.1");
    expect(r.run("publish")).toMatchObject({ code: 1, output: expect.stringContaining("must be annotated") });
    r.git("tag", "-d", "v0.9.1");
    r.git("tag", "-a", "v0.9.1", "HEAD~1", "-m", "Wrong release");
    expect(r.run("publish")).toMatchObject({ code: 1, output: expect.stringContaining("must point to") });
    expect(r.git("ls-remote", "--tags", "origin")).toBe("");
  });

  it("refuses a no-tag baseline whose root version differs from the current version", () => {
    const r = repository();
    const file = join(r.cwd, "apps/desktop/package.json");
    writeFileSync(file, JSON.stringify({ version: "0.10.0" }));
    const lock = join(r.cwd, "package-lock.json");
    writeFileSync(lock, readFileSync(lock, "utf8").replaceAll("0.9.0", "0.10.0"));
    r.git("add", ".");
    r.git("commit", "-m", "feat: undocumented version change");
    r.git("push", "origin", "main");
    expect(r.run("--dry-run")).toMatchObject({ code: 1, output: expect.stringContaining("public root version must match") });
  });

  it("verifies only an annotated release tag already merged to origin/main", () => {
    const r = repository();
    r.prepare();
    r.git("tag", "-a", "v0.9.1", "-m", "Premature release");
    expect(r.run("verify-tag", "v0.9.1")).toMatchObject({ code: 1 });
    r.git("tag", "-d", "v0.9.1");
    r.merge();
    expect(r.run("publish")).toMatchObject({ code: 0 });
    const checked = r.run("verify-tag", "v0.9.1");
    expect(checked).toMatchObject({ code: 0 });
    expect(checked.output).toContain("repair release workflow");
    expect(checked.output).not.toContain("Initial release.");
    expect(r.run("verify-tag", "v0.9.2")).toMatchObject({ code: 1 });
  });

  it("uses the published reachable tag as the next release baseline", () => {
    const r = repository();
    r.prepare();
    r.merge("chore(release): v0.9.1");
    expect(r.run("publish")).toMatchObject({ code: 0 });
    r.commit("feat(120): new feature after first public release");
    r.git("push", "origin", "main");
    const preview = r.run("--dry-run");
    expect(preview).toMatchObject({ code: 0 });
    expect(preview.output).toContain("v0.9.1 → v0.10.0");
    expect(preview.output).not.toContain("repair release workflow");
  });


  it("publishes the merged version commit when main has advanced, and prepares the following release", () => {
    const r = repository();
    r.prepare();
    r.merge();
    const releaseCommit = r.git("rev-parse", "HEAD");
    r.commit("docs: documentation after the release PR");
    r.git("push", "origin", "main");
    const published = r.run("publish");
    expect(published, published.output).toMatchObject({ code: 0 });
    expect(r.git("rev-parse", "v0.9.1^{}")).toBe(releaseCommit);
    expect(r.git("rev-parse", "HEAD")).not.toBe(releaseCommit);
    expect(r.run("publish")).toMatchObject({ code: 0 });
    const preview = r.run("patch", "--dry-run");
    expect(preview, preview.output).toMatchObject({ code: 0 });
    expect(preview.output).toContain("v0.9.1 → v0.9.2");
  });

});

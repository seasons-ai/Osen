import { describe, expect, it } from "vitest";
import { bump, checkMessage, insertSection, levelOf, parse, section } from "./release.ts";

const c = (subject: string, body = "", hash = "abc1234") => parse({ hash, subject, body });

describe("release", () => {
  it("parses a Conventional Commits header", () => {
    expect(c("feat(120-search): поиск")).toEqual({ type: "feat", scope: "120-search", breaking: false, text: "поиск", hash: "abc1234" });
    expect(c("fix!: падение")?.breaking).toBe(true);
    expect(c("refactor: x", "текст\nBREAKING CHANGE: формат журнала")?.breaking).toBe(true);
    expect(c("119-mockup: правило")).toBeNull();
    expect(c("feature: x")).toBeNull();
    expect(c("feat(): x")).toBeNull();
  });

  it("checks the commit message", () => {
    expect(checkMessage("feat(120): поиск\n\nтело")).toBeNull();
    expect(checkMessage("# git comment\nchore(release): v1.0.0\n")).toBeNull();
    expect(checkMessage("Merge branch 'wip/73'")).toBeNull();
    expect(checkMessage("fixup! feat: x")).toBeNull();
    expect(checkMessage("119-mockup: правило")).toContain("does not match the format");
    expect(checkMessage("")).toContain("does not match the format");
  });

  it("derives the level from commits", () => {
    const p = (...s: string[]) => s.map((x) => c(x)!);
    expect(levelOf(p("fix: a", "feat: b", "chore!: c"))).toBe("major");
    expect(levelOf(p("fix: a", "feat: b"))).toBe("minor");
    expect(levelOf(p("perf: a", "docs: b"))).toBe("patch");
    expect(levelOf(p("docs: a", "chore: b"))).toBeNull();
  });

  it("bumps the version", () => {
    expect(bump("0.9.3", "major")).toBe("1.0.0");
    expect(bump("0.9.3", "minor")).toBe("0.10.0");
    expect(bump("0.9.3", "patch")).toBe("0.9.4");
    expect(bump("0.9.3", "0.10.0")).toBe("0.10.0");
    expect(() => bump("0.9.3", "0.9.3")).toThrow();
    expect(() => bump("0.9.3", "0.8.9")).toThrow();
    expect(() => bump("0.9.3", "next")).toThrow();
  });

  it("builds a changelog section", () => {
    const s = section("1.0.0", "2026-10-16", [c("feat(120): поиск", "", "a1")!, c("fix: сбой", "", "b2")!, c("feat!: формат", "", "c3")!, c("docs: x")!]);
    expect(s).toBe([
      "## [1.0.0] — 2026-10-16", "",
      "### Breaking changes", "", "- формат (c3)", "",
      "### Added", "", "- **120**: поиск (a1)", "",
      "### Fixed", "", "- сбой (b2)", "",
    ].join("\n"));
    expect(section("0.9.1", "2026-10-16", [c("chore: x")!])).toContain("No user-facing changes.");
  });

  it("inserts the section above earlier versions", () => {
    const log = "# Журнал\n\nвступление\n\n## [0.9.0] — 2026-10-16\n\nстарое\n";
    expect(insertSection(log, "## [0.9.1] — x\n")).toBe("# Журнал\n\nвступление\n\n## [0.9.1] — x\n\n## [0.9.0] — 2026-10-16\n\nстарое\n");
    expect(insertSection("# Журнал\n", "## [0.1.0] — x\n")).toBe("# Журнал\n\n## [0.1.0] — x\n");
  });
});

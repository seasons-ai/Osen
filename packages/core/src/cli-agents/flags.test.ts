import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { declaredFlags, parseCodexFeatures } from "./flags.ts";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const claude = declaredFlags(fx("claude-2.1.288-help.txt"));
const codex = declaredFlags(fx("codex-0.159.2-exec-help.txt"));

describe("declaredFlags", () => {
  it("claude: required flags declared", () => {
    for (const f of ["--print", "--model", "--output-format", "--json-schema", "--tools", "--strict-mcp-config", "--setting-sources", "--system-prompt", "--no-session-persistence", "--disable-slash-commands", "--bare", "--name"]) {
      expect(claude.has(f), f).toBe(true);
    }
  });
  it("claude: both spellings on one line", () => {
    expect(claude.has("--disallowedTools") && claude.has("--disallowed-tools")).toBe(true);
  });
  it("claude: description continuations do not declare flags", () => {
    expect(claude.has("--system-prompt-snapshot")).toBe(true);
    expect(claude.has("--append-system-prompt")).toBe(true);
    expect(claude.has("--tmux")).toBe(true);
    expect(claude.has("--all")).toBe(false);
  });
  it("claude: flag mentioned only in another's description is not declared", () => {
    expect(fx("claude-2.1.288-help.txt")).toContain("--permission-prompt-tool");
    expect(claude.has("--permission-prompt-tool")).toBe(false);
  });
  it("codex exec: required flags declared", () => {
    for (const f of ["--model", "--sandbox", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--output-schema", "--json", "--disable", "--enable", "--config", "--help", "--version"]) {
      expect(codex.has(f), f).toBe(true);
    }
  });
  it("codex: --last mentioned only in description", () => {
    expect(fx("codex-0.159.2-exec-help.txt")).toContain("--last");
    expect(codex.has("--last")).toBe(false);
  });
  it("synthetic text", () => {
    const h = "Options:\n  -x, --alpha <v>   desc\n                    use --beta or\n      --gamma   d\n";
    expect([...declaredFlags(h)].sort()).toEqual(["--alpha", "--gamma"]);
  });
});

describe("parseCodexFeatures", () => {
  const f = parseCodexFeatures(fx("codex-0.159.2-features.txt"));
  it("contains live capabilities, including a two-word stage", () => {
    for (const n of ["shell_tool", "unified_exec", "hooks", "memories", "plugins", "agent_message_board"]) expect(f.has(n), n).toBe(true);
  });
  it("does not contain removed", () => {
    expect(f.has("js_repl")).toBe(false);
    expect(f.has("search_tool")).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CODEX_ISOLATION_FEATURES, HELP_ARGS, participantSystemPrompt, planLaunch } from "./args.ts";
import type { LaunchInput } from "./args.ts";
import { declaredFlags, parseCodexFeatures } from "./flags.ts";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const claudeFlags = declaredFlags(fx("claude-2.1.288-help.txt"));
const codexFlags = declaredFlags(fx("codex-0.159.2-exec-help.txt"));
const features = parseCodexFeatures(fx("codex-0.159.2-features.txt"));
const schema = { json: '{"type":"object"}', file: "/tmp/schema.json" };
const claudeIn: LaunchInput = { agent: "claude", flags: claudeFlags, version: "2.1.288", model: "default", language: "ru" };
const codexIn: LaunchInput = { agent: "codex", flags: codexFlags, version: "0.159.2", model: "default", language: "ru", features };
const without = (s: ReadonlySet<string>, f: string) => new Set([...s].filter((x) => x !== f));
const okArgs = (p: ReturnType<typeof planLaunch>) => {
  if (!p.ok) throw new Error(p.reason);
  return p;
};

describe("planLaunch", () => {
  it("HELP_ARGS", () => {
    expect(HELP_ARGS).toEqual({ claude: ["--help"], codex: ["exec", "--help"] });
  });
  it("claude: exact set without model and schema", () => {
    const p = okArgs(planLaunch(claudeIn));
    expect(p.args).toEqual(["--print", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--system-prompt", participantSystemPrompt("ru"), "--no-session-persistence", "--disable-slash-commands"]);
    expect(p.structured).toBe(false);
  });
  it("claude: model and schema at the end", () => {
    const p = okArgs(planLaunch({ ...claudeIn, model: "sonnet", schema }));
    expect(p.args.slice(-4)).toEqual(["--model", "sonnet", "--json-schema", schema.json]);
    expect(p.structured).toBe(true);
  });
  it("codex: exact set with schema", () => {
    const p = okArgs(planLaunch({ ...codexIn, schema }));
    expect(p.args).toEqual([
      "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--json",
      ...CODEX_ISOLATION_FEATURES.flatMap((f) => (features.has(f) ? ["--disable", f] : [])),
      "--output-schema", schema.file, "-",
    ]);
    expect(p.args.filter((a) => a === "--disable")).toHaveLength(CODEX_ISOLATION_FEATURES.filter((f) => features.has(f)).length);
    expect(p.structured).toBe(true);
  });
  it("codex: --disable order, extra names from the list are not passed, model before schema", () => {
    const p = okArgs(planLaunch({ ...codexIn, model: "gpt-x", schema, features: new Set([...CODEX_ISOLATION_FEATURES, "nope"]) }));
    expect(p.args.slice(8)).toEqual([...CODEX_ISOLATION_FEATURES.flatMap((f) => ["--disable", f]), "--model", "gpt-x", "--output-schema", schema.file, "-"]);
  });
  it("codex pinned with --config: -c check_for_update_on_startup=false after --disable, before model, schema and -", () => {
    expect(codexFlags.has("--config")).toBe(true);
    const p = okArgs(planLaunch({ ...codexIn, pinned: true, model: "gpt-x", schema }));
    expect(p.args.slice(8)).toEqual([...CODEX_ISOLATION_FEATURES.flatMap((f) => ["--disable", f]), "-c", "check_for_update_on_startup=false", "--model", "gpt-x", "--output-schema", schema.file, "-"]);
  });
  it("codex: unpinned has no -c; claude pinned is unchanged", () => {
    const plain = okArgs(planLaunch(codexIn)).args;
    expect(plain).not.toContain("-c");
    expect(okArgs(planLaunch({ ...claudeIn, pinned: true })).args).toEqual(okArgs(planLaunch(claudeIn)).args);
  });
  it("codex pinned without --config: not launched, the reason names --config (self-update could not be turned off)", () => {
    const p = planLaunch({ ...codexIn, pinned: true, flags: without(codexFlags, "--config") });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain("--config");
    expect(okArgs(planLaunch({ ...codexIn, flags: without(codexFlags, "--config") })).args).not.toContain("-c");
  });
  it("codex without features: unavailable, reason — version and unread list", () => {
    const p = planLaunch({ ...codexIn, features: undefined });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.reason).toContain("0.159.2");
      expect(p.reason).toContain("codex features list");
    }
  });
  it.each(CODEX_ISOLATION_FEATURES)("codex: %s is not in the list — unavailable, reason names the name and version", (name) => {
    const p = planLaunch({ ...codexIn, features: without(features, name) });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.reason).toContain(name);
      expect(p.reason).toContain("0.159.2");
      for (const other of CODEX_ISOLATION_FEATURES) if (other !== name) expect(p.reason.split(/[\s,:]+/)).not.toContain(other);
    }
  });
  it("codex: empty list — reason names all isolation capabilities", () => {
    const p = planLaunch({ ...codexIn, features: new Set() });
    expect(p.ok).toBe(false);
    if (!p.ok) for (const name of CODEX_ISOLATION_FEATURES) expect(p.reason).toContain(name);
  });

  const required: [LaunchInput, string][] = [
    ...["--print", "--output-format", "--tools", "--strict-mcp-config", "--setting-sources", "--system-prompt", "--no-session-persistence"].map((f): [LaunchInput, string] => [claudeIn, f]),
    ...["--sandbox", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--json", "--disable"].map((f): [LaunchInput, string] => [codexIn, f]),
  ];
  it.each(required)("%o without %s: unavailable", (input, flag) => {
    const p = planLaunch({ ...input, flags: without(input.flags, flag) });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.reason).toContain(flag);
      expect(p.reason).toContain(input.version!);
    }
  });
  it("reason without version and with several flags", () => {
    const p = planLaunch({ ...claudeIn, version: undefined, flags: new Set() });
    expect(p).toMatchObject({ ok: false });
    if (!p.ok) expect(p.reason).toMatch(/^Установленная версия claude не объявляет флаг --print, --output-format/);
  });

  it("optional flags removed: ok, without them, structured false", () => {
    let flags = without(without(claudeFlags, "--json-schema"), "--disable-slash-commands");
    let p = okArgs(planLaunch({ ...claudeIn, flags, schema }));
    expect(p.args).not.toContain("--json-schema");
    expect(p.args).not.toContain("--disable-slash-commands");
    expect(p.structured).toBe(false);
    flags = without(codexFlags, "--output-schema");
    p = okArgs(planLaunch({ ...codexIn, flags, schema }));
    expect(p.args).not.toContain("--output-schema");
    expect(p.structured).toBe(false);
  });
  it.each([claudeIn, codexIn])("$agent: every --flag is in flags", (input) => {
    const p = okArgs(planLaunch({ ...input, model: "m", schema }));
    for (const a of p.args) if (a.startsWith("--")) expect(input.flags.has(a), a).toBe(true);
  });
  it("--bare is not used", () => {
    expect(claudeFlags.has("--bare")).toBe(true);
    expect(okArgs(planLaunch(claudeIn)).args).not.toContain("--bare");
  });
  it.each([claudeIn, codexIn])("$agent: model without --model is unavailable", (input) => {
    const p = planLaunch({ ...input, model: "x", flags: without(input.flags, "--model") });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain("только модель по умолчанию");
  });
});

describe("System prompt of the CLI participant in the session language", () => {
  it("en: English prompt with the same meaning, isolation flags unchanged", () => {
    const ru = okArgs(planLaunch(claudeIn)).args;
    const en = okArgs(planLaunch({ ...claudeIn, language: "en" })).args;
    const i = ru.indexOf("--system-prompt") + 1;
    expect(en[i]).toBe(participantSystemPrompt("en"));
    expect(en[i]).toMatch(/no tools/);
    expect(en[i]).toMatch(/files field/);
    expect(en[i]).toMatch(/one JSON object/);
    expect(en[i]).not.toMatch(/[А-Яа-яЁё]/);
    expect([...en.slice(0, i), ...en.slice(i + 1)]).toEqual([...ru.slice(0, i), ...ru.slice(i + 1)]);
    expect(okArgs(planLaunch({ ...codexIn, language: "en" }))).toEqual(okArgs(planLaunch(codexIn)));
  });
});

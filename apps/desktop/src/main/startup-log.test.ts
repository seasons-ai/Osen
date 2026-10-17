import type { CliLocation, ProviderStatus } from "@model-council/core";
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@model-council/core";
import { logAppQuit, logMissingClis, logProviders } from "./startup-log.ts";

const st = (o: Partial<ProviderStatus>): ProviderStatus => ({ id: "p", kind: "cli", label: "P", available: true, models: [], modelsConfirmed: false, ...o });

function run(s: ProviderStatus) {
  const lines: string[] = [];
  const logger = { info: (m: string) => lines.push(`info ${m}`), error: (m: string) => lines.push(`error ${m}`) };
  logProviders(logger, [s]);
  return lines;
}

describe("logProviders", () => {
  it("found CLI with a version", () => {
    expect(run(st({ id: "claude", path: "/bin/claude", version: "2.1.0" }))).toEqual(["info Provider claude: found /bin/claude, version 2.1.0"]);
  });
  it("CLI without a version and with a warning", () => {
    expect(run(st({ id: "codex", path: "/bin/codex", warning: "старая версия" }))).toEqual(["info Provider codex: found /bin/codex, version unknown; warning: старая версия"]);
  });
  it("CLI not found: the reason and the search places", () => {
    const [l] = run(st({ id: "claude", available: false, reason: "Команда claude не найдена", searchPath: "/usr/bin:/bin" }));
    expect(l).toMatch(/^error /);
    expect(l).toContain("Команда claude не найдена");
    expect(l).toContain("search locations: /usr/bin:/bin");
  });
  it("available HTTP provider", () => {
    expect(run(st({ id: "local", kind: "openai-http", baseUrl: "http://x/v1" }))).toEqual(["info Provider local: available, address http://x/v1"]);
  });
  it("unavailable HTTP provider without searchPath", () => {
    expect(run(st({ id: "local", kind: "openai-http", available: false }))).toEqual(["error Provider local unavailable: no reason given"]);
  });
});

describe("logMissingClis", () => {
  const log = (l: CliLocation[]) => {
    const lines: string[] = [];
    logMissingClis({ info: (m) => lines.push(m), error: (m) => lines.push(`error ${m}`) }, l);
    return lines;
  };
  it("command not found: one error entry", () => {
    expect(log([{ agent: "codex", found: false, reason: "нет в PATH", searchPath: "/usr/bin:/bin" }])).toEqual(["error CLI codex: нет в PATH; search locations: /usr/bin:/bin"]);
  });
  it("without a reason", () => {
    expect(log([{ agent: "codex", found: false, searchPath: "/bin" }])[0]).toContain("no reason given");
  });
  it("command found: no entry", () => {
    expect(log([{ agent: "claude", found: true, path: "/bin/claude", searchPath: "/bin" }])).toEqual([]);
  });
});

describe("Common log: app shutdown", () => {
  it("logAppQuit writes one INFO [desktop] line with a time; called last in will-quit", () => {
    const dir = mkdtempSync(join(tmpdir(), "council-"));
    try {
      logAppQuit(createLogger(dir, "desktop", {}));
      const lines = readFileSync(join(dir, "logs", "app.log"), "utf8").split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT\S+Z INFO \[desktop\] App exit$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const src = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    const body = /app\.on\("will-quit", \(\) => \{([\s\S]*?)\n  \}\);/.exec(src)?.[1] ?? "";
    const calls = body.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(calls.at(-1)).toBe("logAppQuit(logger);");
    expect(calls.indexOf("polling.stop();")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("bridge.dispose();")).toBeGreaterThanOrEqual(0);
    expect(src).not.toMatch(/before-quit[\s\S]{0,200}logAppQuit/);
  });
});

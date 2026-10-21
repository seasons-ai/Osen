import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkHost, hostsAfter } from "./hosts.ts";
import type { Host } from "./hosts.ts";

const root = resolve(import.meta.dirname, "../../../..");
const expected = join(root, "packages/mcp/src/main.ts");

let tmp: string;
let bin: string;
let home: string;
let log: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hosts-test-"));
  bin = join(tmp, "bin");
  home = join(tmp, "home");
  log = join(tmp, "argv.log");
  mkdirSync(bin);
  mkdirSync(home);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

// Installs a stub host binary: logs argv, prints the fixture, exits with the code.
function stub(host: Host, output: string, code = 0, extra = ""): void {
  writeFileSync(join(tmp, `${host}.out`), output);
  const file = join(bin, host);
  writeFileSync(file, `#!/bin/sh\necho "$*" >> '${log}'\n${extra}cat '${join(tmp, `${host}.out`)}'\nexit ${code}\n`);
  chmodSync(file, 0o755);
}
const run = (host: Host) => checkHost(host, root, { env: { PATH: `${bin}:/bin:/usr/bin`, HOME: home } });
const calls = () => readFileSync(log, "utf8").trim().split("\n");

const claudeEntry = (args: string | null, command = "node", status: string | null = "✓ Connected") =>
  `osen:\n  Scope: Project config (shared via .mcp.json)\n${status === null ? "" : `  Status: ${status}\n`}  Type: stdio\n  Command: ${command}\n${args === null ? "" : `  Args: ${args}\n`}\nTo remove this server, run: claude mcp remove osen -s project\n`;
const codexEntry = (command: string, args: string[]) =>
  JSON.stringify({ name: "osen", enabled: true, transport: { type: "stdio", command, args, env: { OSEN_KEY: "SECRET-VALUE-123" } } });
const claudeMissing = 'No MCP server named "osen". Configured servers: a, b\n';
const codexMissing = "Error: No MCP server named 'osen' found.\n";

const entries: Record<Host, (command: string, args: string[]) => string> = {
  claude: (command, args) => claudeEntry(args.length ? args.join(" ") : null, command),
  codex: codexEntry,
};
const missing: Record<Host, string> = { claude: claudeMissing, codex: codexMissing };
const command: Record<Host, string> = { claude: "mcp get osen", codex: "mcp get osen --json" };

describe.each(["claude", "codex"] as Host[])("%s", (host) => {
  it("is connected for the relative repo server path, and runs only `mcp get osen`", () => {
    stub(host, entries[host]("node", ["packages/mcp/src/main.ts"]));
    const r = run(host);
    expect(r).toMatchObject({ host, state: "connected", detail: "node packages/mcp/src/main.ts" });
    expect(calls()).toEqual([command[host]]);
  });

  it("is connected for the absolute path of the root server file", () => {
    stub(host, entries[host]("node", [expected]));
    expect(run(host).state).toBe("connected");
  });

  it("is not connected when the host says there is no such server", () => {
    stub(host, missing[host], 1);
    expect(run(host)).toMatchObject({ state: "not connected" });
  });

  it("is a mismatch for another repo path and names both paths", () => {
    stub(host, entries[host]("node", ["/opt/other/packages/mcp/src/main.ts"]));
    const r = run(host);
    expect(r.state).toBe("mismatch");
    expect(r.detail).toContain("/opt/other/packages/mcp/src/main.ts");
    expect(r.detail).toContain(expected);
  });

  it("is a mismatch when the right main.ts is run by another command", () => {
    stub(host, entries[host]("bun", ["packages/mcp/src/main.ts"]));
    const r = run(host);
    expect(r.state).toBe("mismatch");
    expect(r.detail).toContain("bun packages/mcp/src/main.ts");
  });

  it("is connected when an absolute node path runs this repository's main.ts", () => {
    stub(host, entries[host]("/opt/homebrew/Cellar/node/26.0.0/bin/node", [expected]));
    expect(run(host).state).toBe("connected");
  });

  it("is a mismatch for the app wrapper without args and names both paths", () => {
    const wrapper = "/Applications/Osen.app/Contents/Resources/bin/osen-mcp";
    stub(host, entries[host](wrapper, []));
    const r = run(host);
    expect(r.state).toBe("mismatch");
    expect(r.detail).toContain(wrapper);
    expect(r.detail).toContain(expected);
  });

  it("is not checked for unrecognized output and does not echo it", () => {
    stub(host, "Segmentation fault SECRET-VALUE-123\n", 139);
    const r = run(host);
    expect(r.state).toBe("not checked");
    expect(r.detail).toContain("unrecognized output");
    expect(r.detail).toContain("139");
    expect(r.detail).not.toContain("Segmentation");
    expect(r.detail).not.toContain("SECRET");
  });

  it("is not checked when the binary is not in PATH", () => {
    const r = checkHost(host, root, { env: { PATH: bin, HOME: home } });
    expect(r.state).toBe("not checked");
    expect(r.detail).toBe(`${host} is not installed (not found in PATH)`);
  });

  it("is not checked when the host does not answer in time", () => {
    stub(host, "", 0, "sleep 5\n");
    const r = checkHost(host, root, { env: { PATH: `${bin}:/bin:/usr/bin`, HOME: home }, timeoutMs: 500 });
    expect(r.state).toBe("not checked");
    expect(r.detail).toContain("did not answer");
  });

  it("creates no files in HOME", () => {
    stub(host, entries[host]("node", ["packages/mcp/src/main.ts"]));
    run(host);
    expect(readdirSync(home)).toEqual([]);
  });
});

describe("claude only", () => {
  it("Проверка контракта после обновления хост-агента: запись Claude ждёт одобрения или не подключилась", () => {
    const pending = "⏸ Pending approval (run `claude` to approve)";
    for (const status of [pending, "✗ Failed to connect"]) {
      stub("claude", claudeEntry("packages/mcp/src/main.ts", "node", status));
      const r = run("claude");
      expect(r.state).toBe("not connected");
      expect(r.detail).toContain(status);
    }
    stub("claude", claudeEntry("/opt/other/packages/mcp/src/main.ts", "node", pending));
    expect(run("claude").state).toBe("mismatch");
    for (const status of ["✓ Connected", null]) {
      stub("claude", claudeEntry("packages/mcp/src/main.ts", "node", status));
      expect(run("claude").state).toBe("connected");
    }
  });

  it("keeps an Args path with a space as one argument", () => {
    stub("claude", claudeEntry("/tmp/a b/packages/mcp/src/main.ts"));
    const r = run("claude");
    expect(r.state).toBe("mismatch");
    expect(r.detail).toContain("/tmp/a b/packages/mcp/src/main.ts");
  });

  it("Проверка контракта после обновления хост-агента: запись с флагами перед файлом сервера", () => {
    for (const args of [`--no-warnings ${expected}`, "--no-warnings --max-old-space-size=4096 packages/mcp/src/main.ts"]) {
      stub("claude", claudeEntry(args));
      expect(run("claude").state).toBe("connected");
    }
    stub("claude", claudeEntry("--no-warnings /tmp/a b/packages/mcp/src/main.ts"));
    const r = run("claude");
    expect(r.state).toBe("mismatch");
    expect(r.detail).toContain("/tmp/a b/packages/mcp/src/main.ts");
    stub("claude", claudeEntry("--no-warnings /opt/other/packages/mcp/src/main.ts"));
    expect(run("claude").state).toBe("mismatch");
    // flags only: the next line of the host output is not taken as the server file
    stub("claude", claudeEntry("--no-warnings"));
    expect(run("claude").detail).toContain("entry runs node --no-warnings, expected");
  });
});

describe("hostsAfter", () => {
  it("Проверка контракта после обновления хост-агента: контракт упал, хосты проверены", async () => {
    stub("claude", claudeEntry("packages/mcp/src/main.ts"));
    stub("codex", codexEntry("node", ["/opt/x/main.ts"]));
    const errors: unknown[] = [];
    const results = await hostsAfter(async () => { throw new Error("connection closed"); }, (e) => errors.push(e), root, { env: { PATH: `${bin}:/bin:/usr/bin`, HOME: home } });
    expect((errors[0] as Error).message).toBe("connection closed");
    expect(results.map(({ host, state }) => ({ host, state }))).toEqual([{ host: "claude", state: "connected" }, { host: "codex", state: "mismatch" }]);
  });
});

describe("codex only", () => {
  it("never puts env values into the detail", () => {
    stub("codex", codexEntry("node", ["/opt/x/main.ts"]));
    expect(run("codex").detail).not.toContain("SECRET-VALUE-123");
    stub("codex", codexEntry("node", ["packages/mcp/src/main.ts"]));
    expect(run("codex").detail).not.toContain("SECRET-VALUE-123");
  });

  it("is not checked for non-JSON output", () => {
    stub("codex", "not json at all\n", 0);
    expect(run("codex").state).toBe("not checked");
  });
});

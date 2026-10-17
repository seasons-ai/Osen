import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runProcess } from "./process.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "proc-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function stub(body: string): string {
  const path = join(dir, "stub.sh");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
const run = (command: string, o: Partial<Parameters<typeof runProcess>[0]> = {}) =>
  runProcess({ command, args: [], cwd: dir, stdin: "", env: { PATH: "/usr/bin:/bin" }, ...o });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}

describe("runProcess", () => {
  it("stdin verbatim", async () => {
    const mark = join(dir, "mark");
    const input = `"a" 'b' $HOME $(touch ${mark}) \`touch ${mark}\` \\n \\\n строка\nвторая\n`;
    const r = await run(stub("cat"), { stdin: input });
    expect(r.stdout).toBe(input);
    expect(existsSync(mark)).toBe(false);
  });
  it("environment and cwd", async () => {
    process.env.COUNCIL_TEST_MARKER = "leak";
    try {
      const r = await run(stub('echo "$COUNCIL_PARTICIPANT"; echo "$COUNCIL_TEST_MARKER"; pwd -P'), { env: { COUNCIL_PARTICIPANT: "1", PATH: "/usr/bin:/bin" } });
      expect(r.stdout).toBe(`1\n\n${realpathSync(dir)}\n`);
    } finally { delete process.env.COUNCIL_TEST_MARKER; }
  });
  it("arguments one by one", async () => {
    const r = await run(stub('for a in "$@"; do echo "[$a]"; done'), { args: ["", "a b", "-x"] });
    expect(r.stdout).toBe("[]\n[a b]\n[-x]\n");
  });
  it("non-zero code", async () => {
    const r = await run(stub("echo oops >&2; exit 3"));
    expect(r).toMatchObject({ exitCode: 3, aborted: false, stderr: "oops\n" });
  });
  it("command does not exist", async () => {
    const r = await run(join(dir, "nope"));
    expect(r.spawnError?.code).toBe("ENOENT");
  });
  it("interruption kills descendants", async () => {
    const pids = join(dir, "pids");
    const ac = new AbortController();
    const p = run(stub(`sleep 300 &\necho "$$ $!" > ${pids}\nwait`), { signal: ac.signal });
    await waitFor(() => existsSync(pids) && readFileSync(pids, "utf8").trim().includes(" "));
    const [a, b] = readFileSync(pids, "utf8").trim().split(" ").map(Number) as [number, number];
    ac.abort();
    expect((await p).aborted).toBe(true);
    await waitFor(() => !alive(a) && !alive(b));
    expect(alive(a)).toBe(false);
    expect(alive(b)).toBe(false);
  });
  it("ignoring SIGTERM is killed with SIGKILL", async () => {
    const ready = join(dir, "ready");
    const ac = new AbortController();
    const p = run(stub(`trap '' TERM\ntouch ${ready}\nwhile :; do sleep 1; done`), { signal: ac.signal, killGraceMs: 200 });
    await waitFor(() => existsSync(ready));
    ac.abort();
    const r = await p;
    expect(r).toMatchObject({ aborted: true, signal: "SIGKILL" });
  });
  it("signal interrupted before launch", async () => {
    const mark = join(dir, "mark");
    const r = await run(stub(`touch ${mark}`), { signal: AbortSignal.abort() });
    expect(r).toEqual({ exitCode: null, signal: null, stdout: "", stderr: "", aborted: true });
    expect(existsSync(mark)).toBe(false);
  });
  it("onStdout and large output", async () => {
    const chunks: string[] = [];
    const r = await run(stub("head -c 1500000 /dev/zero | tr '\\0' x"), { onStdout: (c) => chunks.push(c) });
    expect(r.stdout.length).toBe(1_500_000);
    expect(chunks.join("")).toBe(r.stdout);
    expect(chunks.length).toBeGreaterThan(1);
  });
});


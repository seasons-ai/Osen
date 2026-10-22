import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOutput, runProcess } from "./process.ts";

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


// A background grandchild that ignores SIGTERM and holds no pipes.
// The grandchild writes its own pid after the trap is set, so a stop never lands before it ignores SIGTERM.
const IGNORER = (pidfile: string) => `sh -c 'trap "" TERM; echo $$ > ${pidfile}; exec sleep 20' >/dev/null 2>&1 </dev/null &`;
const readPid = (pidfile: string) => Number(readFileSync(pidfile, "utf8").trim());
const reap = (pid: number) => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } };

describe("Таймаут и прерывание: потомок игнорирует SIGTERM", () => {
  it("leader exits before the kill grace: the grandchild still gets SIGKILL", async () => {
    const pidfile = join(dir, "pid");
    const ac = new AbortController();
    const p = run(stub(`${IGNORER(pidfile)}\nwait`), { signal: ac.signal, killGraceMs: 300 });
    await waitFor(() => existsSync(pidfile) && readFileSync(pidfile, "utf8").trim() !== "");
    const pid = readPid(pidfile);
    try {
      ac.abort();
      expect((await p).aborted).toBe(true);
      await waitFor(() => !alive(pid), 3000);
      expect(alive(pid)).toBe(false);
    } finally { reap(pid); }
  });
  it("leader still alive at the kill grace: leader and grandchild get SIGKILL", async () => {
    const pidfile = join(dir, "pid");
    const ac = new AbortController();
    const p = run(stub(`trap '' TERM\n${IGNORER(pidfile)}\nwhile :; do sleep 1; done`), { signal: ac.signal, killGraceMs: 300 });
    await waitFor(() => existsSync(pidfile) && readFileSync(pidfile, "utf8").trim() !== "");
    const pid = readPid(pidfile);
    try {
      ac.abort();
      expect(await p).toMatchObject({ aborted: true, signal: "SIGKILL" });
      await waitFor(() => !alive(pid), 3000);
      expect(alive(pid)).toBe(false);
    } finally { reap(pid); }
  });
});

describe("readOutput: the CLI read used by candidates and npm", () => {
  it("output over maxBytes: rejects", async () => {
    await expect(readOutput(stub("head -c 2000 /dev/zero | tr '\\0' x"), [], { PATH: "/usr/bin:/bin" }, undefined, 5000, 1024)).rejects.toThrow(/larger than 1024 bytes/);
  });
  it("Срок проверки истёк: a hung command with a SIGTERM-ignoring child times out and its group is killed", async () => {
    const pidfile = join(dir, "pid");
    const e = await readOutput(stub(`${IGNORER(pidfile)}\nsleep 30 & wait`), [], { PATH: "/usr/bin:/bin" }, undefined, 6000).catch((x: unknown) => x);
    const pid = readPid(pidfile);
    try {
      expect((e as Error).message).toMatch(/no answer within 6000 ms/);
      await waitFor(() => !alive(pid), 5000);
      expect(alive(pid)).toBe(false);
    } finally { reap(pid); }
  });
});

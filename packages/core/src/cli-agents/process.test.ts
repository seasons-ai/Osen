import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeExecutable } from "../executable.testutil.ts";
import { OutputError, readOutput, runProcess } from "./process.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "proc-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function stub(body: string): string {
  return writeExecutable(join(dir, "stub.sh"), `#!/bin/sh\n${body}\n`);
}
const run = (command: string, o: Partial<Parameters<typeof runProcess>[0]> = {}) =>
  runProcess({ command, args: [], cwd: dir, stdin: "", env: { PATH: "/usr/bin:/bin" }, ...o });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(what: string, cond: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  if (!cond()) throw new Error(`waited ${ms} ms for: ${what}`);
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
    await waitFor("stub wrote both pids", () => existsSync(pids) && readFileSync(pids, "utf8").trim().includes(" "));
    const [a, b] = readFileSync(pids, "utf8").trim().split(" ").map(Number) as [number, number];
    ac.abort();
    expect((await p).aborted).toBe(true);
    await waitFor("both processes gone", () => !alive(a) && !alive(b));
    expect(alive(a)).toBe(false);
    expect(alive(b)).toBe(false);
  }, 60_000);
  it("ignoring SIGTERM is killed with SIGKILL", async () => {
    const ready = join(dir, "ready");
    const ac = new AbortController();
    const p = run(stub(`trap '' TERM\ntouch ${ready}\nwhile :; do sleep 1; done`), { signal: ac.signal, killGraceMs: 200 });
    await waitFor("stub ready file", () => existsSync(ready));
    ac.abort();
    const r = await p;
    expect(r).toMatchObject({ aborted: true, signal: "SIGKILL" });
  }, 60_000);
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
    await waitFor("grandchild pid file", () => existsSync(pidfile) && readFileSync(pidfile, "utf8").trim() !== "");
    const pid = readPid(pidfile);
    try {
      ac.abort();
      expect((await p).aborted).toBe(true);
      await waitFor("grandchild gone", () => !alive(pid), 3000);
      expect(alive(pid)).toBe(false);
    } finally { reap(pid); }
  }, 60_000);
  it("leader exited on its own, the child holds stdout, the stop comes before close: the child gets SIGKILL after the grace", async () => {
    const pidfile = join(dir, "pid");
    const leaderFile = join(dir, "leader");
    const ac = new AbortController();
    // grace 3000 > the 2000 ms exit-to-close wait: the result comes back before the SIGKILL is due
    const p = run(stub(`echo $$ > ${leaderFile}\nsh -c 'trap "" TERM; echo $$ > ${pidfile}; exec sleep 20' &\nwhile [ ! -s ${pidfile} ]; do sleep 0.05; done\nexit 0`), { signal: ac.signal, killGraceMs: 3000 });
    await waitFor("grandchild pid file and exited leader", () => existsSync(pidfile) && readFileSync(pidfile, "utf8").trim() !== "" && existsSync(leaderFile) && !alive(readPid(leaderFile)));
    const pid = readPid(pidfile);
    try {
      expect(alive(pid)).toBe(true);
      ac.abort();
      expect((await p).aborted).toBe(true);
      await waitFor("grandchild gone", () => !alive(pid), 6000);
      expect(alive(pid)).toBe(false);
    } finally { reap(pid); }
  }, 60_000);
  it("leader still alive at the kill grace: leader and grandchild get SIGKILL", async () => {
    const pidfile = join(dir, "pid");
    const ac = new AbortController();
    const p = run(stub(`trap '' TERM\n${IGNORER(pidfile)}\nwhile :; do sleep 1; done`), { signal: ac.signal, killGraceMs: 300 });
    await waitFor("grandchild pid file", () => existsSync(pidfile) && readFileSync(pidfile, "utf8").trim() !== "");
    const pid = readPid(pidfile);
    try {
      ac.abort();
      expect(await p).toMatchObject({ aborted: true, signal: "SIGKILL" });
      await waitFor("grandchild gone", () => !alive(pid), 3000);
      expect(alive(pid)).toBe(false);
    } finally { reap(pid); }
  }, 60_000);
});

describe("readOutput: the CLI read used by candidates and npm", () => {
  it("output over maxBytes: rejects", async () => {
    await expect(readOutput(stub("head -c 2000 /dev/zero | tr '\\0' x"), [], { PATH: "/usr/bin:/bin" }, undefined, 20_000, 1024)).rejects.toThrow(/larger than 1024 bytes/);
  });
  it("deadline (cli candidates, Срок проверки истёк): a hung read with a SIGTERM-ignoring child times out and its group is killed", async () => {
    // The deadline runs from spawn: if the grandchild never wrote its pid, the run proved nothing; repeat with a doubled deadline.
    let pid = 0;
    for (let ms = 6000, n = 0; ms <= 24_000 && !pid; ms *= 2, n++) {
      const pidfile = join(dir, `pid-${n}`);
      const e = await readOutput(stub(`${IGNORER(pidfile)}\nsleep 30 & wait`), [], { PATH: "/usr/bin:/bin" }, undefined, ms).catch((x: unknown) => x);
      expect((e as Error).message).toMatch(new RegExp(`no answer within ${ms} ms`));
      if (existsSync(pidfile) && readFileSync(pidfile, "utf8").trim() !== "") pid = readPid(pidfile);
    }
    if (!pid) throw new Error("the stub never started before the deadline");
    try {
      await waitFor("grandchild gone", () => !alive(pid), 5000);
      expect(alive(pid)).toBe(false);
    } finally { reap(pid); }
  }, 90_000);
});

describe("readOutput: output limit boundary and typed failures", () => {
  const out = (n: number) => stub(`head -c ${n} /dev/zero | tr '\\0' x`);
  const env = { PATH: "/usr/bin:/bin" };
  it("exactly maxBytes resolves, one byte over rejects with too_large", async () => {
    expect((await readOutput(out(64), [], env, undefined, 20_000, 64)).length).toBe(64);
    const e = await readOutput(out(65), [], env, undefined, 20_000, 64).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OutputError);
    expect((e as OutputError).failure).toEqual({ code: "too_large", maxBytes: 64 });
    expect((e as Error).message).toBe("output is larger than 64 bytes");
  });
  it("exit failure carries the command, code and trimmed stderr", async () => {
    const path = stub('echo " boom " >&2; exit 3');
    const e = await readOutput(path, ["a", "b"], env, undefined, 20_000).catch((x: unknown) => x);
    expect((e as OutputError).failure).toEqual({ code: "exit", command: `${path} a b`, exitCode: 3, signal: null, stderr: "boom" });
    expect((e as Error).message).toBe(`${path} a b exited with 3: boom`);
  });
});

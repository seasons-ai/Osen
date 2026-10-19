import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { main } from "./cli.ts";
import { setProcessLanguage } from "./i18n/index.ts";
import { saveLineup } from "./registry/lineups.ts";
import { appendEvent, createSessionJournal, eventsPath } from "./store/journal.ts";
import type { SessionEvent } from "./protocol/schema.ts";

// Own seeded generator: fast-check is not connected.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_SEED = 139000;
const ITERATIONS = 40;

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "council-machine-")); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
afterEach(() => setProcessLanguage("ru"));

const sc = (dir: string, file: string) => `scripted:${join(import.meta.dirname, "../scenarios", dir, file)}`;
const two = ["--participant", sc("consensus", "p1.json"), "--participant", sc("consensus", "p2.json")];
const three = ["--participant", sc("no-consensus", "p1.json"), "--participant", sc("no-consensus", "p2.json"), "--participant", sc("no-consensus", "p3.json")];

async function run(argv: string[], home: string) {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, {
    stdout: (t) => out.push(t), stderr: (t) => err.push(t),
    env: { COUNCIL_HOME: home, COUNCIL_DEV: "1" },
    inspectDeps: { locate: async (agent) => ({ agent, found: false, searchPath: "", reason: `Команда ${agent} не найдена` }) },
  });
  return { code, out, err: err.join("\n") };
}
const sessionIds = (home: string) => (existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")) : []);

const ts = "2026-01-01T00:00:00.000Z";
const DEAD_PID = 2_000_000_000;
function makeJournal(home: string, id: string, topic: string, pid: number, extra: SessionEvent[] = []) {
  createSessionJournal(home, id);
  appendEvent(home, id, {
    seq: 1, ts, type: "session_created", pid, session: {
      id, createdAt: ts, origin: "cli", topic, templateId: null, framing: "",
      participants: [1, 2].map((i) => ({ id: `p${i}`, name: `n${i}`, providerId: "scripted", model: "m", role: null })),
      limits: { maxRounds: 3, turnTimeoutSec: 60, contextChars: 1000 },
    },
  });
  for (const e of extra) appendEvent(home, id, e);
}
const turn = (seq: number): SessionEvent => ({
  seq, ts, type: "turn_completed", turn: 1, round: 1, participantId: "p1", stance: "amend", normalized: false,
  reasoning: "r", solution: "Text", version: 1, questions: [], answers: [], attempts: 1, usage: {}, durationMs: 1,
});

// topics: quotes, guillemets, LF and CRLF, unicode/emoji, lengths around 60
const pieces = ['"quoted"', "«ёлочки»", "line\nbreak", "crlf\r\nbreak", "эмодзи 🙂🚀", "日本語 テスト", "tab\tinside", "back\\slash", "{\"a\":1}"];
function genTopic(r: () => number): string {
  const len = [1, 5, 59, 60, 61, 62, 100, 300][Math.floor(r() * 8)]!;
  let s = "";
  while ([...s].length < len) s += `${pieces[Math.floor(r() * pieces.length)]!} ${"abcdефг"[Math.floor(r() * 7)]}`;
  s = [...s].slice(0, len).join("");
  return s.trim() === "" || s !== s.trim() ? `${s.trim()}x` || "x" : s;
}

interface Built { home: string; ids: string[]; topics: Map<string, string> }
async function build(r: () => number, empty: boolean): Promise<Built> {
  const home = tmp();
  const topics = new Map<string, string>();
  const startReal = async (argv: string[], rounds: string) => {
    const topic = genTopic(r);
    const before = new Set(sessionIds(home));
    await run(["--topic", topic, ...argv, "--max-rounds", rounds], home);
    const id = sessionIds(home).find((i) => !before.has(i))!;
    topics.set(id, topic);
  };
  const manual = (id: string, pid: number, extra: SessionEvent[], tail?: string) => {
    const topic = genTopic(r);
    makeJournal(home, id, topic, pid, extra);
    if (tail !== undefined) appendFileSync(eventsPath(home, id), tail);
    topics.set(id, topic);
  };
  if (empty) return { home, ids: [], topics };
  if (r() < 0.7) await startReal(two, "3"); // consensus
  if (r() < 0.5) await startReal(three, "2"); // no_consensus
  if (r() < 0.5) manual("dead", DEAD_PID, []); // running with a dead pid -> interrupted
  if (r() < 0.4) manual("newer", 1, [turn(2)], `{"seq":3,"ts":"${ts}","type":"future_event"}\n`);
  if (r() < 0.4) manual("bad", 1, [turn(2)], '{"seq":3,"ts":"');
  if (r() < 0.5) {
    const n = 1 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) await saveLineup(home, { name: `Состав «${i}» "q"`, participants: [{ providerId: "scripted", model: "m", role: null }, { providerId: "scripted", model: "m", role: "критик" }] });
  }
  return { home, ids: [...topics.keys()], topics };
}

function commands(ids: string[]): string[][] {
  return [["list"], ...ids.flatMap((id) => [["status", id], ["show", id]]), ["providers"], ["templates"], ["lineups"], ["doctor"]];
}

// language-dependent parts that are compared in a narrowed form
function normalize(argv: string[], text: string): string {
  const d = JSON.parse(text);
  if (argv[0] === "doctor") { delete d.language; return JSON.stringify(d); }
  if (argv[0] === "templates") {
    // category text and the order (sorted by the localized category) come from per-language files; ids and sources must match
    const idSource = d.templates.map((t: { id: string; source: string }) => `${t.id}:${t.source}`).sort();
    return JSON.stringify({ templates: idSource, errors: d.errors });
  }
  return text;
}

describe("Машинный вывод --json", () => {
  it("property: every command gives one JSON document on stdout, equal in en and ru, with no document text in stderr", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = BASE_SEED + i;
      const r = mulberry32(seed);
      const { home, ids, topics } = await build(r, i % 8 === 0);
      await run(["doctor", "--json"], home); // creates config.json, so `created` is stable
      for (const argv of commands(ids)) {
        const label = `seed ${seed} (base ${BASE_SEED}): ${argv.join(" ")}`;
        const texts: string[] = [];
        for (const lang of ["ru", "en"] as const) {
          setProcessLanguage(lang);
          const res = await run([...argv, "--json"], home);
          expect(res.code, `${label} ${lang} code`).toBe(0);
          expect(res.out, `${label} ${lang} one stdout call`).toHaveLength(1);
          const parsed = JSON.parse(res.out[0]!);
          expect(parsed.schemaVersion, `${label} ${lang} schemaVersion`).toBe(1);
          expect(res.err.includes('"schemaVersion"'), `${label} ${lang} document in stderr`).toBe(false);
          for (const line of res.err.split("\n")) {
            expect(() => JSON.parse(line), `${label} ${lang} stderr line parses as JSON`).toThrow();
          }
          if (argv[0] === "list") {
            expect(parsed.sessions.length, label).toBe(ids.length);
            if (parsed.sessions.length === 0) seen.add("empty");
            for (const s of parsed.sessions) seen.add(`${s.status}/${s.partial?.reason ?? "full"}`);
            for (const s of parsed.sessions) {
              const t: string = s.topic, n = [...t].length;
              if (n === 60) seen.add("len60");
              if (n === 61) seen.add("len61");
              if (t.includes("\r\n")) seen.add("crlf");
              if (/(^|[^\r])\n/.test(t)) seen.add("lf");
              if (/\p{Extended_Pictographic}/u.test(t)) seen.add("emoji");
              if (t.includes('"') && t.includes("«")) seen.add("quote");
            }
            for (const s of parsed.sessions) expect(s.topic, `${label} topic of ${s.id}`).toBe(topics.get(s.id));
          }
          texts.push(res.out[0]!);
        }
        expect(normalize(argv, texts[1]!), `${label} en vs ru`).toBe(normalize(argv, texts[0]!));
        if (!["doctor", "templates"].includes(argv[0]!)) expect(texts[1], `${label} byte-equal`).toBe(texts[0]);
      }
    }
    // the generator must reach the boundary states
    for (const want of ["empty", "consensus/full", "no_consensus/full", "interrupted/full", "running/newer_version", "running/corrupted", "len60", "len61", "lf", "crlf", "emoji", "quote"]) {
      expect([...seen], `generator never reached ${want}`).toContain(want);
    }
  }, 120_000);
});

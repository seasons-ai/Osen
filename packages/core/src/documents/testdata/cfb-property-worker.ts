import { parentPort, workerData } from "node:worker_threads";
import { systemKind } from "../detect.ts";
import { DocError } from "../limits.ts";
import { makeCfb } from "../fixture.ts";

// Seeded generator (LCG, no Math.random): the verdict must depend only on the set of stream names.
let state = workerData.seed >>> 0;
const rnd = (n: number): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return Math.floor((state / 2 ** 32) * n); };
const word = (): string => Array.from({ length: 1 + rnd(20) }, () => String.fromCharCode(97 + rnd(26))).join("") + rnd(1000);

const failures: string[] = [];
for (let i = 0; i < workerData.cases; i++) {
  const names = Array.from({ length: rnd(4) === 0 ? rnd(600) : rnd(12) }, word);
  const enc = rnd(3) === 0, wd = rnd(2) === 0;
  if (enc) names.splice(rnd(names.length + 1), 0, "EncryptedPackage");
  if (wd) names.splice(rnd(names.length + 1), 0, "WordDocument");
  const mode = rnd(10);
  const spec = { streams: names, ...(mode === 0 ? { loop: true } : mode === 1 ? { outside: true } : {}) };
  const expected = mode <= 1 ? "damaged" : enc ? "encrypted" : wd ? "doc" : "unsupported";
  let actual: string;
  try { actual = systemKind(makeCfb(spec)) ?? "none"; } catch (e) { actual = e instanceof DocError ? e.code : `error ${e}`; }
  if (actual !== expected) failures.push(`case ${i} (${names.length} names, mode ${mode}): expected ${expected}, got ${actual}`);
}
parentPort!.postMessage(failures);

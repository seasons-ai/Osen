// Live check of change 219: Western 8-bit text is refused instead of being read as Windows-1251, UTF-16 with a BOM and a control
// char gets the non-text reason of UTF-8 (real council process, scripted participants, ru, 0 model calls).
//   COUNCIL_DEV=1 node packages/core/scenarios/western-8bit/check.ts
// The stand creates .council-data/western-8bit-check-*, deletes it on success and keeps it on failure.
import "../language-ru.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { enc1251, utf16le } from "../../src/text-encoding.testutil.ts";

if (process.env.COUNCIL_DEV !== "1") {
  console.error("Run: COUNCIL_DEV=1 node packages/core/scenarios/western-8bit/check.ts");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../../../..");
mkdirSync(join(repo, ".council-data"), { recursive: true });
const home = realpathSync(join(repo, ".council-data")) + `/western-8bit-check-${Date.now()}-${randomBytes(3).toString("hex")}`;
const fx = join(home, "fx");
mkdirSync(fx, { recursive: true });

const LATIN = "Prénom;Ville;Remarque\nRené;Genève;très bien, déjà payé\nJürgen;München;schön, Grüße\n";
const RU = "Имя;Город;Комментарий\nИван;Москва;оплачено, ivan@mail.ru, PDF-файл через Wi-Fi роутер\nОлеся;Київ;їжак ґанок Європа\n";
const ENC = "кодировка не распознана — нужен UTF-8, UTF-16 с BOM или Windows-1251";
const NON_TEXT = "двоичный файл неизвестного формата";
writeFileSync(join(fx, "latin1.csv"), Buffer.from(LATIN, "latin1"));
writeFileSync(join(fx, "u16ctl.txt"), utf16le("при\u0001вет"));
writeFileSync(join(fx, "u8ctl.txt"), "при\u0001вет");
writeFileSync(join(fx, "ru1251.csv"), enc1251(RU));

const parts = ["p1", "p2"].flatMap((p) => ["--participant", `scripted:${join(repo, "packages/core/scenarios/consensus", `${p}.json`)}`]);
const sessions = () => (existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")) : []);
function council(attach: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [join(repo, "packages/core/src/council.ts"), "--topic", "t", "--attach", attach, ...parts, "--max-rounds", "3"], {
    cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", COUNCIL_DEV: "1", COUNCIL_LANG: "ru", COUNCIL_HOME: home },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}
let n = 0;
const ok = (s: string) => console.log(`ok ${++n}: ${s}`);

try {
  for (const [file, reason] of [["latin1.csv", ENC], ["u16ctl.txt", NON_TEXT], ["u8ctl.txt", NON_TEXT]] as const) {
    const r = council(join(fx, file));
    assert.equal(r.code, 2, r.out);
    assert.ok(r.out.includes(`«${file}»: ${reason}`), r.out);
    assert.ok(!r.out.includes("Prйnom") && !r.out.includes("Mьnchen"), r.out);
    assert.deepEqual(sessions(), [], r.out);
    ok(`${file}: exit 2, «${reason}», no session`);
  }
  const ru = council(join(fx, "ru1251.csv"));
  assert.equal(ru.code, 0, ru.out);
  const [id] = sessions();
  assert.equal(readFileSync(join(home, "sessions", id!, "materials", "m1.txt"), "utf8"), RU);
  ok("ru1251.csv: exit 0, m1.txt equals the Russian and Ukrainian source");

  const dir = council(fx);
  assert.equal(dir.code, 0, dir.out);
  assert.ok(dir.out.includes("Материалы: 1,"), dir.out);
  for (const line of [`fx/latin1.csv — ${ENC}`, `fx/u16ctl.txt — ${NON_TEXT}`, `fx/u8ctl.txt — ${NON_TEXT}`]) assert.ok(dir.out.includes(line), dir.out);
  ok("folder: ru1251.csv collected, latin1.csv, u16ctl.txt, u8ctl.txt skipped with their reasons");

  rmSync(home, { recursive: true, force: true });
  console.log(`western-8bit check: ${n} checks passed, 0 model calls`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  console.error(`western-8bit check FAILED; data kept in ${home}`);
  process.exit(1);
}

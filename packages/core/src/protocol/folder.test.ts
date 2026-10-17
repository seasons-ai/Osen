import { describe, it, expect } from "vitest";
import { FOLDER_LIMITS, folderMap, folderStats, serveFiles } from "./folder.ts";

const f = (name: string, text = "x") => ({ name, text });

describe("folderStats", () => {
  it("number of files and sum of characters", () => {
    expect(folderStats([f("d/a", "abc"), f("d/b", "12")])).toEqual({ files: 2, chars: 5 });
    expect(folderStats([f("d/a", "😀")]).chars).toBe(2);
    expect(folderStats([])).toEqual({ files: 0, chars: 0 });
  });
});

describe("folderMap", () => {
  const files = [f("d/z/deep.txt", "1234"), f("d/b.txt", "12"), f("d/a.txt", "123"), f("d/z/y/deeper.txt", "1")];
  it("closer to the root first, within depth by name; line format", () => {
    expect(folderMap(files, "ru").split("\n")).toEqual(["d/a.txt — 3", "d/b.txt — 2", "d/z/deep.txt — 4", "d/z/y/deeper.txt — 1"]);
  });
  it("with a small limit, deep files are collapsed by folder", () => {
    // the limit also covers collapsed lines: fewer names remain, folders collapse into an ancestor
    const m = folderMap(files, "ru", 59).split("\n");
    expect(m).toEqual(["d/a.txt — 3", "d/ — файлов: 3, знаков: 7 (перечень по запросу)"]);
  });
  it("everything fits: no collapsed lines", () => {
    expect(folderMap(files, "ru")).not.toContain("перечень по запросу");
  });
});

describe("serveFiles", () => {
  const files = [f("d/a.txt", "hello"), f("d/sub/b.txt", "bb"), f("d/sub/c.txt", "c")];
  it("whole file", () => {
    expect(serveFiles(files, ["d/a.txt"], "ru")).toEqual([{ name: "d/a.txt", chars: 5, shown: 5, text: "hello", note: null }]);
  });
  it("unknown name and leaving the folder", () => {
    for (const r of serveFiles(files, ["nope", "../secret.txt"], "ru")) {
      expect(r.text).toBe("");
      expect(r.note).toBe("нет в папке владельца");
    }
  });
  it("sixth name and repeats", () => {
    const r = serveFiles(files, ["a", "b", "c", "d", "e", "f", "a"], "ru");
    expect(r).toHaveLength(6);
    expect(r[5]).toMatchObject({ name: "f", text: "", shown: 0, note: "сверх пяти имён за запрос" });
    expect(serveFiles(files, ["d/a.txt", "d/a.txt"], "ru")).toHaveLength(1);
  });
  it("volume limit and budget exhaustion", () => {
    const big = [f("d/big", "x".repeat(70000)), f("d/next", "y")];
    const [a, b] = serveFiles(big, ["d/big", "d/next"], "ru");
    expect(a).toMatchObject({ shown: FOLDER_LIMITS.readChars, chars: 70000, note: "показаны первые 40000 из 70000 знаков" });
    expect(a!.text.length).toBe(40000);
    expect(b).toMatchObject({ text: "", shown: 0, note: "не поместился: исчерпан объём чтения за ход" });
  });
  it("folder with / at the end: file list", () => {
    const [r] = serveFiles(files, ["d/sub/"], "ru");
    expect(r!.text).toBe("d/sub/b.txt — 2\nd/sub/c.txt — 1");
    expect(r!.chars).toBe(r!.text.length);
    expect(r!.shown).toBe(r!.chars);
  });

  it("serveFiles: a name in another Unicode normalization finds the file", () => {
    const nfd = "Мозговой штурм/a.md".normalize("NFD");
    const nfcName = "Мозговой штурм/a.md".normalize("NFC");
    expect(nfd).not.toBe(nfcName);
    expect(serveFiles([{ name: nfd, text: "текст" }], [nfcName], "ru")[0]).toMatchObject({ shown: 5, note: null, text: "текст" });
  });
});

describe("Requested files and collapsed folder in the session language", () => {
  const files = [f("d/z/deep.txt", "1234"), f("d/a.txt", "123"), f("d/z/y/q.txt", "1"), f("d/z/y/r.txt", "12")];
  it("en: collapsed folder line and reasons for incomplete display in English, names unchanged", () => {
    expect(folderMap(files, "en", 58).split("\n")).toEqual(["d/a.txt — 3", "d/ — files: 3, characters: 7 (list on request)"]);
    const big = [f("d/big", "x".repeat(70000)), f("d/next", "y")];
    expect(serveFiles(big, ["d/big", "d/next", "nope", "a", "b", "c"], "en").map((r) => [r.name, r.note])).toEqual([
      ["d/big", "the first 40000 of 70000 characters are shown"],
      ["d/next", "did not fit: the reading volume for the turn is exhausted"],
      ["nope", "not in the owner's folder"],
      ["a", "not in the owner's folder"],
      ["b", "not in the owner's folder"],
      ["c", "over five names per request"],
    ]);
  });
});

// Reference of the previous rule: names greedily, collapsed lines after the limit check.
function oldFolderMap(files: readonly { name: string; text: string }[], limit: number): string {
  const depth = (n: string) => n.split("/").length;
  const sorted = [...files].sort((a, b) => depth(a.name) - depth(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lines: string[] = [];
  let used = 0;
  let i = 0;
  for (; i < sorted.length; i++) {
    const l = `${sorted[i]!.name} — ${sorted[i]!.text.length}`;
    const next = used + l.length + (lines.length > 0 ? 1 : 0);
    if (next > limit) break;
    lines.push(l);
    used = next;
  }
  const g = new Map<string, { c: number; n: number }>();
  for (const x of sorted.slice(i)) {
    const d = x.name.slice(0, x.name.lastIndexOf("/"));
    const e = g.get(d) ?? { c: 0, n: 0 };
    e.c++;
    e.n += x.text.length;
    g.set(d, e);
  }
  for (const d of [...g.keys()].sort()) lines.push(`${d}/ — файлов: ${g.get(d)!.c}, знаков: ${g.get(d)!.n} (перечень по запросу)`);
  return lines.join("\n");
}

describe("Section 'Owner's folder'", () => {
  const FOLDED = /^(.*)\/ — файлов: (\d+), знаков: (\d+) \(перечень по запросу\)$/;
  const parse = (out: string) => {
    const folded = out.split("\n").map((l) => FOLDED.exec(l)).filter((x) => x !== null);
    return { count: folded.reduce((s, x) => s + Number(x![2]), 0), chars: folded.reduce((s, x) => s + Number(x![3]), 0), n: folded.length };
  };
  const named = (out: string) => out.split("\n").filter((l) => !FOLDED.test(l)).length;

  for (const dirs of [500, 3000]) {
    it(`${dirs} folders with one file each: list no longer than the limit, all files counted`, () => {
      const files = Array.from({ length: dirs }, (_, i) => f(`root/d${String(i).padStart(4, "0")}${"n".repeat(20)}/f.txt`, "x".repeat(i % 7 + 1)));
      const out = folderMap(files, "ru");
      expect(out.length).toBeLessThanOrEqual(FOLDER_LIMITS.mapChars);
      const p = parse(out);
      expect(p.count).toBe(files.length - named(out));
      expect(p.chars).toBe(files.slice(named(out)).reduce((s, x) => s + x.text.length, 0));
    });
  }

  it("deep folders collapse into ancestors before root files lose their names", () => {
    const files = [
      ...Array.from({ length: 10 }, (_, i) => f(`r/top${i}.txt`, "ab")),
      ...Array.from({ length: 150 }, (_, i) => f(`r/g${i % 5}/sub/c${String(i).padStart(3, "0")}/x.txt`, "abc")),
    ];
    const out = folderMap(files, "ru", 700);
    expect(out.length).toBeLessThanOrEqual(700);
    for (let i = 0; i < 10; i++) expect(out).toContain(`r/top${i}.txt — 2`);
    const keys = out.split("\n").map((l) => FOLDED.exec(l)?.[1]).filter((k) => k !== undefined) as string[];
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k.split("/").length).toBeLessThanOrEqual(3);
    expect(keys).toContain("r/g4/sub");
  });

  it("if the previous rule fits the limit, the text is the same", () => {
    const files = [f("d/z/deep.txt", "1234"), f("d/b.txt", "12"), f("d/a.txt", "123"), f("d/z/y/deeper.txt", "1"), f("d/z/y/w/e.txt", "12")];
    const lim = "d/a.txt — 3\nd/b.txt — 2\nd/z/ — файлов: 3, знаков: 7 (перечень по запросу)".length;
    for (const limit of [lim, 200, 12000]) {
      const old = oldFolderMap(files, limit);
      if (old.length <= limit) expect(folderMap(files, "ru", limit)).toBe(old);
    }
    const mid = oldFolderMap(files, 200);
    expect(mid.length).toBeLessThanOrEqual(200);
    expect(folderMap(files, "ru", 200)).toBe(mid);
  });

  it("nothing fits even at level 1: whole lines, no longer than the limit", () => {
    const A = "a".repeat(30);
    const files = [...Array.from({ length: 9 }, (_, i) => f(`${A}/f${i}`, "1")), ...Array.from({ length: 9 }, (_, i) => f(`${"b".repeat(30)}/f${i}`, "1"))];
    const one = `${A}/ — файлов: 9, знаков: 9 (перечень по запросу)`;
    expect(folderMap(files, "ru", one.length + 3)).toBe(one);
    expect(folderMap(files, "ru", 5)).toBe("");
  });
});

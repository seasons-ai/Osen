export type DiffPart = { kind: "same" | "add" | "del"; text: string };
export interface SolutionDiff { parts: DiffPart[]; added: number; removed: number; byLines: boolean }

export const MAX_WORDS = 2000;
export const MAX_CHARS = 20000;

const countWords = (s: string): number => s.match(/\S+/g)?.length ?? 0;

function push(parts: DiffPart[], kind: DiffPart["kind"], text: string): void {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) last.text += text;
  else parts.push({ kind, text });
}

function finish(parts: DiffPart[], byLines: boolean): SolutionDiff {
  let added = 0;
  let removed = 0;
  for (const p of parts) {
    if (p.kind === "add") added += countWords(p.text);
    else if (p.kind === "del") removed += countWords(p.text);
  }
  return { parts, added, removed, byLines };
}

// ponytail: long texts are compared coarsely by lines (common start and end, the middle counts as replaced); exact comparison is needed if the owner asks.
function diffLines(prev: string, next: string): SolutionDiff {
  const split = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = split(prev);
  const b = split(next);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const parts: DiffPart[] = [];
  push(parts, "same", a.slice(0, head).join(""));
  push(parts, "del", a.slice(head, a.length - tail).join(""));
  push(parts, "add", b.slice(head, b.length - tail).join(""));
  push(parts, "same", a.slice(a.length - tail).join(""));
  return finish(parts, true);
}

function diffWords(prev: string, next: string): SolutionDiff {
  const pw = prev.match(/\S+/g) ?? [];
  const nm = [...next.matchAll(/\S+/g)];
  const nw = nm.map((m) => m[0]);
  const n = pw.length;
  const m = nw.length;
  let head = 0;
  while (head < n && head < m && pw[head] === nw[head]) head++;
  let tail = 0;
  while (tail < n - head && tail < m - head && pw[n - 1 - tail] === nw[m - 1 - tail]) tail++;
  const a = pw.slice(head, n - tail);
  const b = nw.slice(head, m - tail);
  const w = b.length + 1;
  // L[i][j] — LCS length of the suffixes a[i:] and b[j:]
  const L = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
    }
  }
  const isAdd: boolean[] = new Array(m).fill(false);
  const dels: string[][] = Array.from({ length: m + 1 }, () => []);
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (j >= b.length || (i < a.length && L[(i + 1) * w + j]! >= L[i * w + j + 1]!)) dels[head + j]!.push(a[i++]!);
    else isAdd[head + j++] = true;
  }
  const parts: DiffPart[] = [];
  let pos = 0;
  for (let k = 0; k <= m; k++) {
    const start = k < m ? nm[k]!.index! : next.length;
    const gap = next.slice(pos, start);
    const between = k > 0 && k < m && isAdd[k - 1] && isAdd[k] && dels[k]!.length === 0;
    push(parts, between ? "add" : "same", gap);
    push(parts, "del", dels[k]!.join(" "));
    if (k < m) {
      push(parts, isAdd[k] ? "add" : "same", nw[k]!);
      pos = start + nw[k]!.length;
    }
  }
  return finish(parts, false);
}

/** prev — version N−1, next — the selected version N. */
export function diffSolution(prev: string, next: string): SolutionDiff {
  const long = prev.length > MAX_CHARS || next.length > MAX_CHARS || countWords(prev) > MAX_WORDS || countWords(next) > MAX_WORDS;
  return long ? diffLines(prev, next) : diffWords(prev, next);
}

export interface OcrLine { t: string; x: number; y: number; w: number; h: number }

/** Reading order of recognized lines: top to bottom, then left to right; independent of the input order. */
export function orderLines(lines: readonly OcrLine[]): string {
  const items = lines.map((l) => ({ ...l, t: l.t.trim() })).filter((l) => l.t !== "");
  items.sort((a, b) => a.y - b.y || a.x - b.x || a.h - b.h || a.w - b.w || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const rows: (typeof items)[] = [];
  for (const item of items) {
    const row = rows[rows.length - 1];
    const first = row?.[0];
    if (row && first) {
      const overlap = Math.min(first.y + first.h, item.y + item.h) - Math.max(first.y, item.y);
      if (overlap > Math.min(first.h, item.h) / 2) { row.push(item); continue; }
    }
    rows.push([item]);
  }
  return rows.map((r) => r.sort((a, b) => a.x - b.x).map((l) => l.t).join(" ")).join("\n");
}

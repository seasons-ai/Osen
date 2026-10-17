const MARKER = /^(\d{1,3})[.)] (.*)$/s;

/** Version text from numbered lines → items without numbers; otherwise null. */
export function parseNumberedList(text: string): string[] | null {
  const items: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    const m = MARKER.exec(line);
    if (!m) return null;
    items.push(m[2] as string);
  }
  return items.length >= 2 ? items : null;
}

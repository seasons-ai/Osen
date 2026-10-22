import { DocError } from "./limits.ts";

export interface XmlElement { name: string; attrs: Record<string, string>; children: (XmlElement | string)[] }

const MAX_DEPTH = 1000;
const damaged = (): never => { throw new DocError("damaged"); };
const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeXml(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return damaged(); }
}

function entities(s: string): string {
  let i = s.indexOf("&");
  if (i < 0) return s;
  let out = "", from = 0;
  while (i >= 0) {
    const semi = s.indexOf(";", i);
    if (semi < 0 || semi - i > 10) damaged();
    const ref = s.slice(i + 1, semi);
    let ch: string | undefined = Object.hasOwn(NAMED, ref) ? NAMED[ref] : undefined;
    if (ch === undefined && ref[0] === "#") {
      const hex = ref[1] === "x";
      const digits = ref.slice(hex ? 2 : 1);
      if (digits === "" || !(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) damaged();
      const cp = parseInt(digits, hex ? 16 : 10);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0) damaged();
      ch = String.fromCodePoint(cp);
    }
    if (ch === undefined) damaged();
    out += s.slice(from, i) + ch;
    from = semi + 1;
    i = s.indexOf("&", from);
  }
  return out + s.slice(from);
}

export function parseXml(text: string): XmlElement {
  if (text.includes("<!DOCTYPE") || text.includes("<!ENTITY")) damaged();
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  const addText = (t: string): void => {
    const top = stack[stack.length - 1];
    if (!top) { if (t.trim() !== "") damaged(); return; }
    if (t === "") return;
    const last = top.children[top.children.length - 1];
    if (typeof last === "string") top.children[top.children.length - 1] = last + t;
    else top.children.push(t);
  };
  const n = text.length;
  let pos = 0;
  while (pos < n) {
    const lt = text.indexOf("<", pos);
    if (lt < 0) { addText(entities(text.slice(pos))); break; }
    if (lt > pos) addText(entities(text.slice(pos, lt)));
    if (text.startsWith("<?", lt)) {
      const e = text.indexOf("?>", lt + 2);
      if (e < 0) damaged();
      pos = e + 2;
    } else if (text.startsWith("<!--", lt)) {
      const e = text.indexOf("-->", lt + 4);
      if (e < 0) damaged();
      pos = e + 3;
    } else if (text.startsWith("<![CDATA[", lt)) {
      const e = text.indexOf("]]>", lt + 9);
      if (e < 0 || stack.length === 0) damaged();
      addText(text.slice(lt + 9, e));
      pos = e + 3;
    } else if (text.startsWith("<!", lt)) {
      damaged();
    } else if (text.startsWith("</", lt)) {
      const e = text.indexOf(">", lt + 2);
      if (e < 0) damaged();
      const top = stack.pop();
      if (!top || text.slice(lt + 2, e).trimEnd() !== top.name) damaged();
      pos = e + 1;
    } else {
      let i = lt + 1;
      while (i < n && !isSpace(text.charCodeAt(i)) && text[i] !== "/" && text[i] !== ">") i++;
      const el: XmlElement = { name: text.slice(lt + 1, i), attrs: {}, children: [] };
      if (el.name === "" || el.name.includes("=")) damaged();
      for (;;) {
        while (i < n && isSpace(text.charCodeAt(i))) i++;
        if (i >= n) damaged();
        if (text[i] === ">" || text[i] === "/") break;
        const ns = i;
        while (i < n && !isSpace(text.charCodeAt(i)) && text[i] !== "=" && text[i] !== ">" && text[i] !== "/") i++;
        const attr = text.slice(ns, i);
        while (i < n && isSpace(text.charCodeAt(i))) i++;
        if (attr === "" || text[i] !== "=") damaged();
        i++;
        while (i < n && isSpace(text.charCodeAt(i))) i++;
        const q = text[i];
        if (q !== '"' && q !== "'") damaged();
        const qe = text.indexOf(q!, i + 1);
        if (qe < 0) damaged();
        el.attrs[attr] = entities(text.slice(i + 1, qe));
        i = qe + 1;
        if (i < n && !isSpace(text.charCodeAt(i)) && text[i] !== ">" && text[i] !== "/") damaged();
      }
      const selfClosing = text[i] === "/";
      if (selfClosing) { i++; if (text[i] !== ">") damaged(); }
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(el);
      else if (root) damaged();
      else root = el;
      if (!selfClosing) {
        stack.push(el);
        if (stack.length > MAX_DEPTH) damaged();
      }
      pos = i + 1;
    }
  }
  if (!root || stack.length > 0) damaged();
  return root!;
}

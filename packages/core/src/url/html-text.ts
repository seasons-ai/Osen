import { parse, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

const SKIP = new Set(["head", "script", "style", "noscript", "template", "svg", "iframe"]);
const BLOCK = new Set(("address article aside blockquote body dd div dl dt fieldset figcaption figure footer form " +
  "h1 h2 h3 h4 h5 h6 header hr html li main nav ol p pre section table tr ul").split(" "));
const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden/i;

function hidden(el: Element): boolean {
  for (const { name, value } of el.attrs) {
    if (name === "hidden") return true;
    if (name === "aria-hidden" && value.trim().toLowerCase() === "true") return true;
    if (name === "style" && HIDDEN_STYLE.test(value)) return true;
  }
  return false;
}

type Item = { node: Node; pre: boolean } | "close";

export function htmlToText(html: string): string {
  const paragraphs: string[] = [];
  let buf = "";
  let verbatim = false;

  const flush = (): void => {
    const p = verbatim
      ? buf.replace(/^\n+|\n+$/g, "")
      : buf.split("\n").map((l) => l.replace(/ {2,}/g, " ").trim()).join("\n").replace(/^\n+|\n+$/g, "");
    if (p.trim()) paragraphs.push(p);
    buf = "";
    verbatim = false;
  };

  const stack: Item[] = [{ node: parse(html), pre: false }];
  while (stack.length) {
    const item = stack.pop()!;
    if (item === "close") { flush(); continue; }
    const { node, pre } = item;
    if (node.nodeName === "#text") {
      const v = (node as DefaultTreeAdapterMap["textNode"]).value;
      buf += pre ? v : v.replace(/[ \t\n\r\f]+/g, " ");
      continue;
    }
    if (!("childNodes" in node)) continue;
    let childPre = pre;
    if (node.nodeName !== "#document") {
      const el = node as Element;
      const tag = el.tagName;
      if (SKIP.has(tag) || hidden(el)) continue;
      if (tag === "br") { buf += "\n"; continue; }
      if (tag === "td" || tag === "th") buf += " ";
      if (BLOCK.has(tag)) {
        flush();
        if (tag === "pre") { childPre = true; verbatim = true; }
        stack.push("close");
      }
    }
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push({ node: node.childNodes[i]!, pre: childPre });
  }
  flush();
  return paragraphs.join("\n\n").trim().replace(/[\x00-\x08\x0e-\x1f\x7f]/g, "");
}

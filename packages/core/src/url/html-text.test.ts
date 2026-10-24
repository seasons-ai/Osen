import { describe, it, expect } from "vitest";
import { htmlToText } from "./html-text.ts";

const STATIC_PAGE = '<html><head><title>T</title><script>var a=1</script><style>p{}</style></head><body><h1>Заголовок</h1><p>Первый <b>абзац</b>.</p><script>alert("X")</script><img src="http://example.com/a.png" alt="ALT"><p>Второй абзац.</p></body></html>';

describe("htmlToText", () => {
  it("static page: only visible text", () => {
    const t = htmlToText(STATIC_PAGE);
    expect(t).toBe("Заголовок\n\nПервый абзац.\n\nВторой абзац.");
  });

  it("hidden elements are skipped along with their descendants", () => {
    const t = htmlToText(
      '<p hidden>H1</p><div aria-hidden="TRUE"><b>H2</b></div><p style="display: none">H3</p>' +
      '<p style="VISIBILITY:hidden"><i>H4</i></p><p aria-hidden="false">видно1</p><p style="color:red">видно2</p>');
    expect(t).toBe("видно1\n\nвидно2");
  });

  it("noscript, template, svg, iframe are skipped", () => {
    const t = htmlToText("<p>a</p><noscript>NS</noscript><template><p>TPL</p></template><svg><text>SVG</text></svg><iframe>IF</iframe><p>b</p>");
    expect(t).toBe("a\n\nb");
  });

  it("whitespace, br, nested inline, entities, link without href", () => {
    const t = htmlToText('<p>  а \n\t б<br>в   <span><b><em>г</em></b></span> &amp; &#x41; &nbsp;д <a href="http://x.y/z">ссылка</a></p>');
    expect(t).toBe("а б\nв г & A \u00a0д ссылка");
  });

  it("pre keeps line breaks and indentation", () => {
    expect(htmlToText("<p>до</p><pre>a\n    b\n  c</pre><p>после</p>")).toBe("до\n\na\n    b\n  c\n\nпосле");
  });

  it("table and lists", () => {
    expect(htmlToText("<table><tr><td>a</td><td>b</td></tr><tr><th>c</th><td>d</td></tr></table>")).toBe("a b\n\nc d");
    expect(htmlToText("<ul><li>один</li><li>два</li></ul>")).toBe("один\n\nдва");
  });

  it("text without markup, empty string, scripts only", () => {
    expect(htmlToText("просто текст")).toBe("просто текст");
    expect(htmlToText("")).toBe("");
    expect(htmlToText("<script>x()</script>")).toBe("");
  });

  it("20000 nested divs do not overflow the stack", () => {
    const html = "<div>".repeat(20000) + "текст" + "</div>".repeat(20000);
    expect(typeof htmlToText(html)).toBe("string");
  });

  it("control characters from entities do not reach the result", () => {
    expect(htmlToText("<p>a&#1;b&#127;c</p>")).toBe("abc");
  });

  it("a self-closing <title/> in a page still opens title (EPUB chapters expand it, pages do not)", () => {
    expect(htmlToText("<html><head><title/></head><body><p>Hello chapter</p></body></html>")).toBe("");
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { markdown, plainLines, richHtml } from "./markdown.js";

test("blocks", () => {
  assert.equal(markdown("# One\n\nSome *text*\nand more  \nend"), "<h1>One</h1>\n<p>Some <em>text</em><br>and more<br>end</p>", "a line break is kept");
  assert.equal(markdown("```\n<b>x</b>\n\n  y\n```"), "<pre><code>&lt;b&gt;x&lt;/b&gt;\n\n  y</code></pre>");
  assert.equal(markdown("> quoted\n> **too**"), "<blockquote><p>quoted<br><strong>too</strong></p></blockquote>");
  assert.equal(markdown("a\n\n***\n\nb"), "<p>a</p>\n<hr>\n<p>b</p>");
  assert.equal(markdown("| a | b |\n|---|:-:|\n| 1 | 2 |"), '<table><thead><tr><th>a</th><th align="center">b</th></tr></thead><tbody><tr><td>1</td><td align="center">2</td></tr></tbody></table>');
});

test("lists", () => {
  assert.equal(markdown("- a\n- b\n  - c\n- d"), "<ul><li>a</li><li>b\n<ul><li>c</li></ul></li><li>d</li></ul>");
  assert.equal(markdown("3. three\n4. four"), '<ol start="3"><li>three</li><li>four</li></ol>');
  assert.equal(markdown("- a\n\n- b"), "<ul><li><p>a</p></li><li><p>b</p></li></ul>", "loose: paragraphs");
  assert.equal(markdown("- [ ] todo\n- [x] done"), "<ul><li>☐ todo</li><li>☑ done</li></ul>");
  assert.equal(markdown("- a\ngoing on\n\nafter"), "<ul><li>a\ngoing on</li></ul>\n<p>after</p>".replace("a\ngoing on", "a<br>going on"));
});

test("inline", () => {
  const md = (s) => markdown(s).replace(/^<p>|<\/p>$/g, "");
  assert.equal(md("**b** __b__ *i* _i_ ~~s~~ `c*d*`"), "<strong>b</strong> <strong>b</strong> <em>i</em> <em>i</em> <del>s</del> <code>c*d*</code>");
  assert.equal(md("snake_case_name and 2*3*4"), "snake_case_name and 2*3*4", "not emphasis");
  assert.equal(md('[a](https://x.test/a_(b) "t") ![p](https://x.test/p.png)'), '<a href="https://x.test/a_(b)">a</a> <img src="https://x.test/p.png" alt="p">');
  assert.equal(md("see https://x.test/a?b=1&c=2."), 'see <a href="https://x.test/a?b=1&amp;c=2">https://x.test/a?b=1&amp;c=2</a>.');
  assert.equal(md("<https://x.test> \\*not\\*"), '<a href="https://x.test">https://x.test</a> *not*');
  assert.equal(md('<img src=x onerror="alert(1)"> & "q"'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;q&quot;", "HTML in it: text");
  assert.equal(markdown("#12 and &#12;", { workItem: (id) => `https://x.test/${id}` }), '<p><a href="https://x.test/12">#12</a> and &amp;#12;</p>');
  assert.equal(md("#12"), "#12", "without workItem: as it is");
});

test("Markdown in Azure DevOps' HTML", () => {
  assert.equal(plainLines("<div>## A</div><div>- b&nbsp;&amp;</div>"), "## A\n- b &");
  assert.equal(plainLines("<div><b>bold</b></div>"), null, "other formatting: HTML");
  assert.equal(richHtml("<div>## A</div><div>text</div>"), "<h2>A</h2>\n<p>text</p>");
  assert.equal(richHtml("<div>Just a line</div>"), "<div>Just a line</div>", "no Markdown in it: as it is");
  assert.equal(richHtml("plain\ntext"), "<p>plain<br>text</p>", "plain text: its lines");
  assert.equal(richHtml("<p>**x**</p>", { format: "Markdown" }), "<p>&lt;p&gt;<strong>x</strong>&lt;/p&gt;</p>", "the field says Markdown");
});

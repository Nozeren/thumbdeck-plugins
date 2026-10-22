import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, markdown, plainLines, richHtml, toMarkdown } from "./markdown.js";

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

test("an HTML field without tags: its entities as characters, escaped once", () => {
  assert.equal(richHtml("[{&quot;a&quot;:1}]"), '<p>[{&quot;a&quot;:1}]</p>', "not &amp;quot;");
  assert.equal(richHtml("Tom &amp; Jerry &lt;3 &#39;x&#39; &#x2014;"), "<p>Tom &amp; Jerry &lt;3 'x' —</p>");
  assert.equal(richHtml("&lt;script&gt;alert(1)&lt;/script&gt;"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>", "still text, never a tag");
  assert.equal(richHtml("a &amp;quot; b"), "<p>a &amp;quot; b</p>", "decoded once only");
  assert.equal(richHtml("**[{&quot;a&quot;:1}]**", { format: "markdown" }), "<p><strong>[{&amp;quot;a&amp;quot;:1}]</strong></p>", "a Markdown field is kept as typed");
});

test("entities", () => {
  assert.equal(decode("&amp;lt; &nbsp;&#65;&#x42;&bogus; &#0;"), "&lt;  AB&bogus; &#0;");
  assert.equal(plainLines("<div>&quot;a&quot; &amp;amp;</div>"), '"a" &amp;');
});

test("@mentions: the people picked become Azure DevOps' mentions", () => {
  const people = [{ name: "Ann", id: "a-1" }, { name: "Ann Lee", id: "a-2" }];
  assert.equal(markdown("cc @Ann Lee and @Ann.", { mentions: people }),
    '<p>cc <a href="#" data-vss-mention="version:2.0,a-2">@Ann Lee</a> and <a href="#" data-vss-mention="version:2.0,a-1">@Ann</a>.</p>', "the longest name first");
  assert.equal(markdown("mail ann@Ann `@Ann` @Annie", { mentions: people }), "<p>mail ann@Ann <code>@Ann</code> @Annie</p>", "not in an email, code or a longer word");
  assert.equal(markdown("@Bob"), "<p>@Bob</p>", "no one picked: text");
});

test("HTML as Markdown, for editing", () => {
  const md = (html) => toMarkdown(html).text;
  assert.equal(md("<div>One <b>bold</b> line</div><div><br></div><div>Two</div>"), "One **bold** line\n\nTwo", "the editor's lines");
  assert.equal(md("<p>a<br>b</p><h2>Head</h2><ul><li>x<ul><li>y</li></ul></li><li>z</li></ul>"), "a\nb\n\n## Head\n\n- x\n  - y\n- z");
  assert.equal(md('<ol start="3"><li>c</li><li>d</li></ol>'), "3. c\n4. d");
  assert.equal(md('<p><a href="https://x.test/a b">the page</a> <a href="https://y.test">https://y.test</a> <img src="https://i.test/p.png" alt="pic"></p>'),
    "[the page](https://x.test/a%20b) https://y.test ![pic](https://i.test/p.png)");
  assert.equal(md("<pre><code>if (a &lt; b)\n  go()</code></pre>"), "```\nif (a < b)\n  go()\n```");
  assert.equal(md("<blockquote><p>said</p></blockquote>"), "> said");
  assert.equal(md("<div>2 * 3 and [x] # not a heading</div><div># this either</div>"), "2 \\* 3 and \\[x\\] # not a heading\n\\# this either", "marks escaped");
  assert.equal(md("<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2|3</td></tr></table>"), "| a | b |\n| --- | --- |\n| 1 | 2\\|3 |");
  assert.equal(md("<div>x<script>alert(1)</script></div>"), "x");
  assert.equal(md("plain &amp; text"), "plain & text");
});

test("HTML as Markdown: mentions kept, what can't be kept said", () => {
  const r = toMarkdown('<div><a href="#" data-vss-mention="version:2.0,ad96-1">@John Doe</a>&nbsp;<u>see</u> <span style="color:red">this</span></div><table><tr><td colspan="2">x</td></tr></table>');
  assert.deepEqual(r.mentions, [{ name: "John Doe", id: "ad96-1" }]);
  assert.deepEqual(r.lost.sort(), ["colours", "merged table cells", "underlines"]);
  assert.match(r.text, /^@John Doe see this/);
});

test("Markdown → HTML → Markdown gives the same text", () => {
  const src = "Some **bold**, *em* and `code`\nnext line\n\n## Head\n\n- one\n- two\n  - deeper\n\n1. first\n2. second\n\n> quote\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```\nx < y\n```\n\ncc @Ann Lee, see [it](https://x.test)";
  const people = [{ name: "Ann Lee", id: "a-2" }];
  const back = toMarkdown(markdown(src, { mentions: people }));
  assert.equal(back.text, src);
  assert.deepEqual(back.mentions, people);
});

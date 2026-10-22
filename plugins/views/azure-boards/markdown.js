// Markdown as HTML: what Azure DevOps keeps in a Markdown field or comment, or what people type
// as Markdown into its HTML editor, and the comments typed here. GitHub's flavour, as far as
// work items use it: headings, paragraphs (a line break is kept), emphasis, code, links and
// images, lists (nested, with tasks), quotes, tables, rules, and #123 for a work item. Raw HTML
// in it is shown as text. What comes out is still made safe before it's shown (rich.js).

/** HTML's entities as the characters they stand for (&amp;, &quot;, &#39;, &#x27;, &nbsp;…) */
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const decode = (s) => String(s).replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, e) => {
  if (e[0] !== "#") return NAMED[e.toLowerCase()] ?? all;
  const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
});

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const indent = (line) => line.match(/^\s*/)[0].length;
const blank = (line) => !line.trim();
const starts = (line) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line);

/** Markdown as HTML. workItem(id): a work item's page, for #123 (none: left as it is);
 *  mentions: [{ name, id }], the people picked for @Name (Azure DevOps' @mention, which tells them) */
export function markdown(src, { workItem, mentions = [] } = {}) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const people = mentions.filter((m) => m?.name && m?.id).sort((a, b) => b.name.length - a.name.length);
  return blocks(lines, { workItem, people });
}

/** An @mention as Azure DevOps keeps it */
export const mentionHtml = (name, id) => `<a href="#" data-vss-mention="version:2.0,${esc(id)}">@${esc(name)}</a>`;
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function blocks(lines, o) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    let m;
    if ((m = FENCE.exec(line))) {
      const close = new RegExp(`^ {0,3}${m[1][0]}{${m[1].length},}\\s*$`);
      const code = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    if ((m = HEADING.exec(line))) {
      out.push(`<h${m[1].length}>${inline(m[2] ?? "", o)}</h${m[1].length}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted = [];
      for (; i < lines.length && !blank(lines[i]) && (QUOTE.test(lines[i]) || !starts(lines[i])); i++) quoted.push(lines[i].replace(QUOTE, ""));
      out.push(`<blockquote>${blocks(quoted, o)}</blockquote>`);
      continue;
    }
    if (line.includes("|") && TABLE_RULE.test(lines[i + 1] ?? "") && lines[i + 1].includes("-")) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, "|"), o));
      const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : ""));
      const head = cells(line);
      const body = [];
      for (i += 2; i < lines.length && !blank(lines[i]) && lines[i].includes("|"); i++) body.push(cells(lines[i]));
      const row = (tag, r) => `<tr>${head.map((_, n) => `<${tag}${align[n] ? ` align="${align[n]}"` : ""}>${r[n] ?? ""}</${tag}>`).join("")}</tr>`;
      out.push(`<table><thead>${row("th", head)}</thead><tbody>${body.map((r) => row("td", r)).join("")}</tbody></table>`);
      continue;
    }
    if (ITEM.test(line)) {
      const [html, next] = list(lines, i, o);
      out.push(html);
      i = next;
      continue;
    }
    const para = [];
    for (; i < lines.length && !blank(lines[i]) && (!para.length || !starts(lines[i])); i++) para.push(lines[i].trim());
    out.push(`<p>${inline(para.join("\n"), o)}</p>`);
  }
  return out.join("\n");
}

/** A list from line i: its HTML, and the line after it */
function list(lines, i, o) {
  const first = ITEM.exec(lines[i]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let loose = false;
  while (i < lines.length) {
    const line = lines[i];
    const m = ITEM.exec(line);
    if (m && m[1].length === base && /\d/.test(m[2]) === ordered) {
      items.push([m[3]]);
      i++;
      continue;
    }
    if (blank(line)) {
      // The list goes on after a blank line if what follows is indented, or its next item
      let j = i;
      while (j < lines.length && blank(lines[j])) j++;
      const after = lines[j];
      const more = after !== undefined && (indent(after) > base || (ITEM.test(after) && ITEM.exec(after)[1].length === base));
      if (!more) break;
      loose = true;
      items.at(-1).push("");
      i++;
      continue;
    }
    if (indent(line) > base) items.at(-1).push(line.slice(Math.min(indent(line), base + 2)));
    else if (!starts(line) && !blank(items.at(-1).at(-1))) items.at(-1).push(line.trim()); // a paragraph going on
    else break;
    i++;
  }
  const html = items.map((content) => {
    let body = blocks(content, o);
    if (!loose) body = body.replace(/^<p>([\s\S]*?)<\/p>/, "$1"); // a tight list: no paragraphs
    body = body.replace(/^\[( |x|X)\]\s*/, (_, x) => (x === " " ? "☐ " : "☑ "));
    return `<li>${body}</li>`;
  }).join("");
  const tag = ordered ? "ol" : "ul";
  return [`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ""}>${html}</${tag}>`, i];
}

/** Emphasis, code, links, images, line breaks, #123 */
function inline(s, o) {
  const kept = []; // finished HTML, out of the way of what comes next
  const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => keep(`<code>${esc(code.trim())}</code>`));
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_, c) => keep(esc(c)));
  s = s.replace(/<(https?:\/\/[^\s>]+|mailto:[^\s>]+)>/g, (_, url) => keep(`<a href="${esc(url)}">${esc(url)}</a>`));
  for (const p of o.people ?? []) s = s.replace(new RegExp(`(^|[^\\w@])@${reEscape(p.name)}(?![\\w])`, "g"), (_, before) => before + keep(mentionHtml(p.name, p.id)));
  s = esc(s);
  const url = String.raw`((?:[^()\s]|\([^()\s]*\))+)(?:\s+&quot;(.*?)&quot;)?`;
  s = s.replace(new RegExp(String.raw`!\[([^\]]*)\]\(\s*${url}\s*\)`, "g"), (_, alt, src) => keep(`<img src="${src}" alt="${alt}">`));
  s = s.replace(new RegExp(String.raw`\[([^\]]+)\]\(\s*${url}\s*\)`, "g"), (_, label, href) => keep(`<a href="${href}">${label}</a>`));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/g, (_, before, link) => before + keep(`<a href="${link}">${link}</a>`));
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>");
  s = s.replace(/(^|[^\w*])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  if (o.workItem) s = s.replace(/(?<![\w&#]|&amp;)#(\d{1,9})\b/g, (_, id) => keep(`<a href="${esc(o.workItem(Number(id)))}">#${id}</a>`));
  s = s.replace(/ {2,}\n|\\\n|\n/g, "<br>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => kept[n]);
}

// Markdown typed into Azure DevOps' HTML editor: plain lines in <div>s, which the editor shows
// as they were typed. Lines starting like Markdown, or **bold**, `code` or [links](…) in them.
const PLAIN_TAGS = /^(div|p|br|span)$/i;
const MARKS = /^\s*(#{1,6}\s|[-*+]\s+\S|\d+[.)]\s+\S|>\s?|```|~~~|\|.*\|\s*$)|\*\*\S[^*]*\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)/m;

/** The lines of HTML that's only plain lines (null: it has other formatting) */
export function plainLines(html) {
  const tags = String(html).match(/<\/?([a-z][\w-]*)[^>]*>/gi) ?? [];
  if (!tags.every((t) => PLAIN_TAGS.test(t.replace(/^<\/?|[\s>].*$/gs, "")))) return null;
  return decode(String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<(div|p)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/^\n/, ""));
}

/** Rich text from Azure DevOps as HTML: Markdown (the field says so, or it's plain text, or
 *  Markdown typed into the HTML editor) rendered; HTML as it is */
export function richHtml(value, { format = "", workItem } = {}) {
  const v = String(value ?? "");
  if (String(format).toLowerCase() === "markdown") return markdown(v, { workItem });
  // Plain text: an HTML field without tags still has its entities (&quot;…): as characters, once
  if (!/<\/?[a-z][^>]*>/i.test(v)) return markdown(decode(v), { workItem });
  const lines = plainLines(v);
  return lines !== null && MARKS.test(lines) ? markdown(lines, { workItem }) : v;
}

// HTML as Markdown: a description or a comment kept as HTML, to edit here as Markdown (and
// written back with markdown() above). Azure DevOps' editor keeps a line as a <div>: each
// becomes a line. What Markdown can't keep (underlines, colours, merged table cells…) is said,
// so it isn't lost without knowing.

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "col", "wbr", "area", "base", "source"]);
const SKIP = new Set(["script", "style", "head", "title", "template", "noscript", "iframe", "object", "svg", "math"]);
const BLOCK = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "pre", "blockquote", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "hr", "section", "article", "header", "footer", "dl", "dt", "dd"]);
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** HTML as a tree of { tag, attrs, kids } and strings (forgiving, as browsers are) */
function parse(html) {
  const root = { tag: "#root", attrs: {}, kids: [] };
  const stack = [root];
  const top = () => stack.at(-1);
  const re = /<!--[\s\S]*?-->|<!\w[^>]*>|<\/\s*([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</g;
  let m;
  while ((m = re.exec(String(html ?? "")))) {
    const [all, close, open, attrText, selfClose] = m;
    if (close) {
      const tag = close.toLowerCase();
      const at = stack.findLastIndex((n) => n.tag === tag);
      if (at > 0) stack.length = at;
      continue;
    }
    if (open) {
      const tag = open.toLowerCase();
      const attrs = {};
      for (const a of (attrText ?? "").matchAll(ATTR)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
      // A new item or row closes the one before; a block closes an open paragraph
      if (tag === "li") { const at = stack.findLastIndex((n) => n.tag === "li" || n.tag === "ul" || n.tag === "ol"); if (at > 0 && stack[at].tag === "li") stack.length = at; }
      if (tag === "tr") { const at = stack.findLastIndex((n) => n.tag === "tr" || n.tag === "table"); if (at > 0 && stack[at].tag === "tr") stack.length = at; }
      if (tag === "td" || tag === "th") { const at = stack.findLastIndex((n) => n.tag === "td" || n.tag === "th" || n.tag === "tr"); if (at > 0 && stack[at].tag !== "tr") stack.length = at; }
      if (BLOCK.has(tag) && top().tag === "p") stack.pop();
      const node = { tag, attrs, kids: [] };
      top().kids.push(node);
      if (!VOID.has(tag) && !selfClose) stack.push(node);
      continue;
    }
    if (all.startsWith("<!")) continue;
    top().kids.push(decode(all));
  }
  return root;
}

const textOf = (n) => (typeof n === "string" ? n : n.tag === "br" ? "\n" : SKIP.has(n.tag) ? "" : n.kids.map(textOf).join(""));
// Text as Markdown would show it: its marks escaped, where they'd mean something
const plain = (s) => s.replace(/\\/g, "\\\\").replace(/([*`[\]])/g, "\\$1").replace(/~~/g, "\\~~").replace(/(^|\s)_(?=\S)/g, "$1\\_");
const lineStart = (line) => line.replace(/^(\s*)(#{1,6}\s|>|[-+]\s|\d{1,9}[.)]\s)/, "$1\\$2");

/** HTML as Markdown: { text, mentions: [{ name, id }] (the @mentions in it, to keep), lost: what
 *  Markdown can't keep, in words } */
export function toMarkdown(html) {
  const st = { mentions: [], lost: new Set() };
  const text = blocksOf(parse(html).kids, st).join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\s+$/g, "");
  const people = new Map(st.mentions.map((m) => [m.id.toLowerCase(), m]));
  return { text, mentions: [...people.values()], lost: [...st.lost] };
}

/** Block-level nodes as Markdown lines (a blank line between blocks; a <div> a line of its own) */
function blocksOf(nodes, st) {
  const out = [];
  let run = []; // inline nodes on the current line
  const flush = () => {
    if (!run.length) return;
    const t = inlineOf(run, st);
    run = [];
    if (t.trim()) out.push(...t.split("\n").map((l) => lineStart(l.replace(/\s+$/, ""))));
  };
  const gap = () => out.length && out.at(-1) !== "" && out.push("");
  for (const n of nodes) {
    if (typeof n === "string" || !BLOCK.has(n.tag)) {
      run.push(n);
      continue;
    }
    flush();
    const t = n.tag;
    if (t === "div" || t === "section" || t === "article" || t === "header" || t === "footer" || t === "dd" || t === "dt") {
      if (!textOf(n).trim() && !n.kids.some((k) => typeof k !== "string" && (k.tag === "img" || k.tag === "hr"))) out.push(""); // <div><br></div>: an empty line
      else out.push(...blocksOf(n.kids, st));
    } else if (t === "p") {
      gap();
      out.push(...blocksOf(n.kids, st));
      out.push("");
    } else if (/^h[1-6]$/.test(t)) {
      gap();
      out.push(`${"#".repeat(Number(t[1]))} ${inlineOf(n.kids, st).replace(/\n/g, " ").trim()}`, "");
    } else if (t === "hr") {
      gap();
      out.push("---", "");
    } else if (t === "pre") {
      gap();
      const code = textOf(n).replace(/\n$/, "");
      const fence = code.includes("```") ? "~~~" : "```";
      out.push(fence, ...code.split("\n"), fence, "");
    } else if (t === "blockquote") {
      gap();
      out.push(...trimBlank(blocksOf(n.kids, st)).map((l) => (l ? `> ${l}` : ">")), "");
    } else if (t === "ul" || t === "ol") {
      gap();
      out.push(...listOf(n, st), "");
    } else if (t === "table") {
      gap();
      out.push(...tableOf(n, st), "");
    } else out.push(...blocksOf(n.kids, st)); // li, tr… out of place: their content
  }
  flush();
  return out;
}

const trimBlank = (lines) => {
  const l = [...lines];
  while (l.length && !l[0].trim()) l.shift();
  while (l.length && !l.at(-1).trim()) l.pop();
  return l;
};

function listOf(list, st) {
  const ordered = list.tag === "ol";
  let n = Number(list.attrs.start) || 1;
  const out = [];
  for (const li of list.kids) {
    if (typeof li === "string") {
      if (li.trim()) out.push(`- ${plain(li.trim())}`);
      continue;
    }
    if (li.tag !== "li") {
      if (li.tag === "ul" || li.tag === "ol") out.push(...listOf(li, st).map((l) => `  ${l}`)); // a list right in a list
      continue;
    }
    const marker = ordered ? `${n++}. ` : "- ";
    const lines = trimBlank(blocksOf(li.kids, st)).filter((l, i, all) => l || (all[i + 1] && !/^\s*([-*+]|\d+[.)])\s/.test(all[i + 1])));
    const first = (lines.shift() ?? "").replace(/^☐\s*/, "[ ] ").replace(/^☑\s*/, "[x] ");
    out.push(marker + first, ...lines.map((l) => (l ? " ".repeat(marker.length) + l : "")));
  }
  return out;
}

function tableOf(table, st) {
  const rows = [];
  const walk = (n) => {
    for (const k of n.kids) {
      if (typeof k === "string") continue;
      if (k.tag === "tr") rows.push(k.kids.filter((c) => typeof c !== "string" && (c.tag === "td" || c.tag === "th")));
      else if (["thead", "tbody", "tfoot"].includes(k.tag)) walk(k);
    }
  };
  walk(table);
  if (!rows.length) return [];
  if (rows.some((r) => r.some((c) => Number(c.attrs.colspan) > 1 || Number(c.attrs.rowspan) > 1))) st.lost.add("merged table cells");
  const width = Math.max(...rows.map((r) => r.length));
  const cell = (c) => (c ? inlineOf(c.kids, st).replace(/\n+/g, " ").replace(/\|/g, "\\|").trim() : "");
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)];
}

/** Inline nodes as Markdown (a <br>: a new line) */
function inlineOf(nodes, st) {
  let out = "";
  for (const n of nodes) {
    if (typeof n === "string") {
      out += plain(n.replace(/[ \t\r\n]+/g, " ").replace(/\u00a0/g, " "));
      continue;
    }
    const t = n.tag;
    if (SKIP.has(t)) continue;
    const inner = () => inlineOf(n.kids, st);
    const wrap = (mark) => {
      const s = inner();
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
      return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : s;
    };
    if (t === "br") out += "\n";
    else if (t === "b" || t === "strong") out += wrap("**");
    else if (t === "i" || t === "em") out += wrap("*");
    else if (t === "s" || t === "strike" || t === "del") out += wrap("~~");
    else if (t === "code" || t === "kbd") {
      const code = textOf(n);
      const ticks = code.includes("`") ? "``" : "`";
      out += code ? `${ticks}${ticks === "``" ? " " : ""}${code}${ticks === "``" ? " " : ""}${ticks}` : "";
    } else if (t === "a") {
      const mention = /version:2\.0,([\w-]+)/i.exec(n.attrs["data-vss-mention"] ?? "");
      const label = textOf(n).replace(/\s+/g, " ").trim();
      if (mention) {
        const name = label.replace(/^@/, "");
        st.mentions.push({ name, id: mention[1] });
        out += `@${name}`;
      } else {
        const href = n.attrs.href ?? "";
        if (!/^(https?:|mailto:)/i.test(href)) out += inner();
        else if (label === href) out += href;
        else out += `[${inner().replace(/\n/g, " ") || href}](${href.replace(/\s/g, "%20").replace(/\)/g, "%29")})`;
      }
    } else if (t === "img") {
      const src = n.attrs.src ?? "";
      if (src) out += `![${plain(n.attrs.alt ?? "")}](${src.replace(/\s/g, "%20").replace(/\)/g, "%29")})`;
    } else {
      if (t === "u" || t === "ins") st.lost.add("underlines");
      if (t === "font" || (n.attrs.style && /(^|;)\s*(color|background)/i.test(n.attrs.style))) st.lost.add("colours");
      if (t === "sub" || t === "sup") st.lost.add("sub- and superscripts");
      out += inner();
    }
  }
  return out;
}

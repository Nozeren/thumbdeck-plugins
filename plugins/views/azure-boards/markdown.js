// Markdown as HTML: what Azure DevOps keeps in a Markdown field or comment, or what people type
// as Markdown into its HTML editor, and the comments typed here. GitHub's flavour, as far as
// work items use it: headings, paragraphs (a line break is kept), emphasis, code, links and
// images, lists (nested, with tasks), quotes, tables, rules, and #123 for a work item. Raw HTML
// in it is shown as text. What comes out is still made safe before it's shown (rich.js).

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

/** Markdown as HTML. workItem(id): a work item's page, for #123 (none: left as it is) */
export function markdown(src, { workItem } = {}) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return blocks(lines, { workItem });
}

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
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<(div|p)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/^\n/, "");
}

/** Rich text from Azure DevOps as HTML: Markdown (the field says so, or it's plain text, or
 *  Markdown typed into the HTML editor) rendered; HTML as it is */
export function richHtml(value, { format = "", workItem } = {}) {
  const v = String(value ?? "");
  if (String(format).toLowerCase() === "markdown") return markdown(v, { workItem });
  if (!/<\/?[a-z][^>]*>/i.test(v)) return markdown(v, { workItem }); // plain text
  const lines = plainLines(v);
  return lines !== null && MARKS.test(lines) ? markdown(lines, { workItem }) : v;
}

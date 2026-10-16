// Azure DevOps' rich text (descriptions, comments: anyone in the organization writes them) made
// safe to show. It's parsed inert (nothing runs or loads) and copied into new elements: only
// these tags, no attributes but a link's address (opened in the browser by view.js), a table
// cell's span and an image's address (loaded through the backend by view.js).

const KEEP = new Set([
  "p", "div", "span", "br", "hr", "b", "strong", "i", "em", "u", "s", "strike", "del", "ins", "sub", "sup",
  "code", "pre", "kbd", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "a", "img",
]);
// Left out with what's in them (the rest is unwrapped: its text kept)
const DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "svg", "math", "form", "input",
  "button", "textarea", "select", "option", "template", "link", "meta", "base", "noscript", "video", "audio",
  "canvas", "title", "head",
]);

/** The HTML as a safe element: <div class="rich">… */
export function safe(html) {
  const doc = new DOMParser().parseFromString(`<body>${html ?? ""}</body>`, "text/html");
  const out = document.createElement("div");
  out.className = "rich";
  copy(doc.body, out);
  return out;
}

function copy(from, to) {
  for (const n of from.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) to.append(n.data);
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = n.tagName.toLowerCase();
    if (DROP.has(tag)) continue;
    if (!KEEP.has(tag)) {
      copy(n, to);
      continue;
    }
    if (tag === "img") {
      const src = n.getAttribute("src") ?? "";
      if (/^https:\/\//i.test(src)) {
        const img = document.createElement("img");
        img.dataset.src = src;
        img.alt = n.getAttribute("alt") ?? "";
        to.append(img);
      }
      continue;
    }
    const el = document.createElement(tag);
    if (tag === "a") {
      const href = n.getAttribute("href") ?? "";
      if (n.hasAttribute("data-vss-mention")) el.className = "mention"; // @someone
      else if (/^(https?:|mailto:)/i.test(href)) el.dataset.href = href;
    }
    if (tag === "td" || tag === "th") {
      for (const a of ["colspan", "rowspan"]) {
        const v = n.getAttribute(a) ?? "";
        if (/^\d{1,2}$/.test(v)) el.setAttribute(a, v);
      }
    }
    copy(n, el);
    to.append(el);
  }
}

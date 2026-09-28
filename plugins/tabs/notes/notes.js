// Notes: small helpers for the notes tab. Pure functions, tested with `node --test`.

/** Open checklist items ("- [ ] …", "* [ ] …") */
export const openItems = (text) => (text.match(/^\s*[-*+] \[ \]/gm) ?? []).length;

/** Ticks or unticks the checklist item on a line (0-based); other lines stay as they are */
export function toggle(text, line) {
  const lines = text.split("\n");
  const l = lines[line];
  if (l === undefined) return text;
  if (/^\s*[-*+] \[ \]/.test(l)) lines[line] = l.replace("[ ]", "[x]");
  else if (/^\s*[-*+] \[[xX]\]/.test(l)) lines[line] = l.replace(/\[[xX]\]/, "[ ]");
  else return text;
  return lines.join("\n");
}

/** The line (0-based) a character offset is on */
export const lineAt = (text, offset) => text.slice(0, offset).split("\n").length - 1;

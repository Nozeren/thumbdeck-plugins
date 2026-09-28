# Dev utils

A view in the Plugins pane (`Ctrl+p`) for the small things you'd otherwise look up online:
paste something in the box (`i` to type, `p` to paste the clipboard) and it shows everything it
can be read as.

- **JWT**: its header and payload, and when it expires (the signature isn't checked)
- **JSON**: pretty, and on one line; JSON inside a JSON string too
- **Timestamps** (seconds or milliseconds): the date, local and UTC, and how long ago
- **Dates** (`2026-09-28T12:00:00Z`): unix seconds and milliseconds
- **URLs**: the query parameters one per line; URL-encoded text decoded
- **base64**: decoded, when it's text
- Anything: as base64, URL-encoded, and its length in characters and bytes

With the box empty it shows the time now and a new UUID (`n` for another). `j`/`k` move
between results and `y` copies one. Nothing leaves your computer.

# Clipboard

A history of what you copied, in a view in the Plugins pane (`Ctrl+p`): the last 100 texts,
newest first, the highlighted one in full beside the list.

- `y` (or Enter) copies it again, and it goes back to the top.
- `/` searches, `p` pins one (pinned ones stay at the top and are never dropped), `x` removes
  one, `X` clears the rest.
- `s` pauses it, for a while you copy things it shouldn't keep.

It notices copies while thumbdeck runs. Copies a password manager marks as secret (KeePassXC,
KDE's and others on Linux) aren't kept. The history is kept in the plugin's data folder,
readable only by you; Settings (`,`) › Plugins › Clipboard can turn that off (then it's
forgotten when thumbdeck closes) or change how many it keeps.

It needs [Node](https://nodejs.org), and on Linux `wl-clipboard` (Wayland) or `xclip` (X11);
macOS has what it needs.

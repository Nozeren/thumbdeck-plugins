# Files

A file manager in the Plugins pane (`Ctrl+p`), the vim way: the folder above, this folder and
a preview of the highlighted entry, in tabs. It opens at the selected project's folder.

- **Moving**: `j` / `k`, `gg` / `G` (`5G`: the 5th), `l` into a folder (or the whole file in
  the preview), `h` or `-` up, `f` and a letter to the next name starting with it. `/`
  filters the folder as you type.
- **Bookmarks**, as vim's marks: `m` and a letter sets one, `'` and the letter goes there
  (`'h` home, `'d` Downloads, more in Settings).
- **Changing files**: `yy` copies, `dd` moves to the Trash (and `p` somewhere else moves it
  there, like vim's cut), `p` pastes, `u` undoes the last copy, move, rename, new file or
  delete. `cc` renames; `x` selects files one by one, `v` a range (then `y`, `d`, or `c` to
  rename them all as text, saved with `Ctrl+s`). `o` makes a file, `O` a folder.
- **Previews**: code with colours, a git diff for changed files (`gd` opens the review page),
  images, PDFs (with poppler), CSV as a table, archives listed, video length (with ffmpeg).
  Git shows on every file: M changed, U new, I ignored.
- **Space**: `Space e` opens the file in nvim in the project's tmux, `Space t` a terminal
  there, `Space /` finds a file by name under here (fd), `Space g` searches inside the files
  (ripgrep), `Space u` shows what takes the space, `Space h` hidden files, `Space o` the
  order, `Space y p` copies the path. `gx` opens with the default app.
- **Tabs**: `:tabnew`, `:tabclose`, `]b` / `[b` to switch. `:!command` runs a command on the
  selection, in this folder.

The Trash is your system's (`~/.local/share/Trash`, `~/.Trash` on macOS), so files can be
brought back from there too.

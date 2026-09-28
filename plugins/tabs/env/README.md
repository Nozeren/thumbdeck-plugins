# Env check

A tab for projects with a `.env.example` (or `.env.sample`, `.env.template`, `.env.dist`,
`example.env`): the project's `.env` against it, key by key.

- **missing**: in the example, not in your `.env`
- **empty**: in your `.env` with no value, where the example has one
- **example's**: still the example's placeholder (`changeme`, `your-key-here`, `<token>`, …)
- **not in example**: only in your `.env` (maybe the example needs it too)

Values are hidden: `m` shows the highlighted one (until you leave the tab). `a` adds the
missing keys to your `.env` with the example's values (it asks first; nothing else is ever
written). `l` opens the file at that key in the project's tmux. The tab's number shows how many
keys need a look, and it reads the files again when they change.

The files are set in the tab's setup (`S`).

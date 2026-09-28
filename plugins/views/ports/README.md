# Ports

What's listening on which port, in a view in the Plugins pane (`Ctrl+p`): the port, the
address (● means other computers can reach it), the process, **the project it runs in** and
its command line. It looks again every 3 seconds while it's shown.

- `o` opens `http://localhost:<port>` in the browser, `y` copies it.
- `x` stops the process (it asks first); `X` kills one that doesn't stop.

It shows only ports your own processes listen on; Settings (`,`) › Plugins › Ports can show
the system's too. It uses `ss` on Linux and `lsof` on macOS.

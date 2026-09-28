# Calendar

Your calendars in thumbdeck, read-only:

- **Its view** in the Plugins pane (`Ctrl+p`): the coming days' events by day, a line at now,
  the highlighted event's time, place, link and notes beside them. `j` / `k` move, `t` jumps
  back to what's next, `o` opens the meeting (Meet, Zoom, Teams, … or the event's link).
- **What's next**, next to its name in the Plugins pane: "Standup in 12m".
- **Reminders**: a notification a few minutes before an event (5 by default), and the avatar
  waits with you until it starts.

It reads calendars from their **private iCal links** (Settings › Plugins › Calendar): in Google
Calendar, Settings › your calendar › *Secret address in iCal format*; in Outlook, Calendar
settings › Shared calendars › *Publish a calendar* (the ICS link); iCloud and Fastmail have
one too. No login and nothing to set up at Google or Microsoft. Treat the links like
passwords: anyone with one can read that calendar.

Repeating events, exceptions, moved and cancelled occurrences, all-day events and time zones
are understood (`ics.js`, tested). It needs [Node](https://nodejs.org) for its backend, which
starts with thumbdeck so reminders come without the view open.

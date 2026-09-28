// The timer's state, kept in the plugin's storage so the view and the panel share it
const td = window.thumbdeck;

/** { endsAt: ms | null, left: ms (while stopped), history: [{ at, minutes }] } */
export async function state() {
  const minutes = (await td.settings.get()).minutes;
  return (await td.storage.get("timer", { scope: "app" })) ?? { endsAt: null, left: minutes * 60_000, history: [] };
}

export const save = (s) => td.storage.set("timer", s, { scope: "app" });

/** Time left, in ms */
export const left = (s, now = Date.now()) => (s.endsAt ? Math.max(0, s.endsAt - now) : s.left);

/** "12:40" */
export function clock(ms) {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

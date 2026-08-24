/**
 * Light or dark, remembered per machine.
 *
 * A kiosk in a terminal is lit very differently at 05:00 and at 14:00, and the person testing it is
 * looking at lamps — the surround changes what a lit amber reads as. So this is a real setting
 * rather than decoration, and it is the one piece of state this app keeps across reloads: it
 * describes the room, not the devices.
 *
 * The first visit follows the operating system. Choosing overrides it from then on.
 */

export type Theme = "light" | "dark";

const KEY = "peripheral-tester:theme";

const systemTheme = (): Theme =>
  globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";

export function loadTheme(): Theme {
  // A kiosk browser with storage disabled throws rather than returning null, and a tester that
  // will not start because it could not remember a colour is worse than one that forgets.
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
  }
  catch { /* no storage: follow the system, and do not persist */ }
  return systemTheme();
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(KEY, theme);
  }
  catch { /* see loadTheme */ }
}

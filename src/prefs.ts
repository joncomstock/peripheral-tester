/**
 * The handful of choices that describe the bench rather than the devices.
 *
 * Which screen you were on, whether the rail is collapsed, and light or dark: three things a bench
 * operator would otherwise re-set every time the page reloads — and on a kiosk it reloads whenever
 * anyone restarts the backend. Nothing about a *device* is kept here; that all lives in the
 * backend, which is the only thing that knows it.
 *
 * A kiosk browser with storage disabled throws rather than returning null, so every access is
 * guarded. A tester that will not start because it could not remember a colour is worse than one
 * that forgets.
 */

const PREFIX = "peripheral-tester:";

/**
 * A remembered value, or the fallback.
 *
 * `accepts` is not optional. What comes back from storage was written by an older build of this
 * app, so it is untrusted input in the ordinary sense — a device id that no longer exists would
 * otherwise put the shell on a screen that cannot render.
 */
export function recall<T extends string>(key: string, fallback: T, accepts: (value: string) => value is T): T {
  try {
    const saved = localStorage.getItem(PREFIX + key);
    return saved !== null && accepts(saved) ? saved : fallback;
  }
  catch {
    return fallback;
  }
}

export function remember(key: string, value: string): void {
  try {
    localStorage.setItem(PREFIX + key, value);
  }
  catch { /* see the module header */ }
}

/**
 * Light or dark.
 *
 * A real setting rather than decoration: a kiosk in a terminal is lit very differently at 05:00
 * and at 14:00, and the person testing it is looking at lamps — the surround changes what a lit
 * amber reads as.
 */
export type Theme = "light" | "dark";

const isTheme = (value: string): value is Theme => value === "light" || value === "dark";

/** The first visit follows the operating system. Choosing overrides it from then on. */
export const loadTheme = (): Theme =>
  recall("theme", globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light", isTheme);

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  remember("theme", theme);
}

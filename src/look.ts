/**
 * The design's computed visuals.
 *
 * A lamp's appearance, a segmented button's state and the strip preview are all functions of what
 * has been commanded, so they are computed rather than expressed as class combinations. Everything
 * static lives in `styles.css`; only what varies is here.
 *
 * Colours that do not vary with state are read from the theme's custom properties rather than
 * written as literals, so the one set of tokens in `styles.css` is what light and dark both come
 * from — a hex here would be a third theme nobody can switch.
 *
 * These lamps show what the page **commanded**. The board acknowledges commands and never reports
 * lamp state, so a lit lamp here means "we asked for this", which is what a control panel can
 * honestly show. Confirming the kiosk agrees is done by looking at the kiosk.
 */

import type { CSSProperties } from "react";
import type { Action } from "./api.ts";

export const LAMP = {
  amber: "#ef9f14",
  green: "#1f9d47",
  red: "#d93a3a",
  blue: "#2d7ce0",
  yellow: "#e5b00d",
  orange: "#e77b18",
  cyan: "#12a6b8",
  magenta: "#c33bb0",
  white: "#e9edf2",
  purple: "#8b5cf6",
  turquoise: "#14b8a6",
} as const;

export const ACCENT = "var(--accent)";

/** How a lamp is behaving. `pulse` is the tester's own "working on it", not a board state. */
export type LampMode = Action | "pulse";

/** The tone a badge, a log line or a sweep result carries. */
export type Tone = "neutral" | "ok" | "warn" | "bad" | "muted" | "normal";

/**
 * Colour of the physical lamp a strip, semaphore or LED control drives.
 *
 * `black` is the vendor's spelling of "off" on the passport reader's status LED, and `off` is this
 * app's — neither is a colour, so both fall back rather than resolving to something the lamp would
 * then be drawn in. The caller decides the mode; this only decides the hue.
 */
export function lampColor(label: string): string {
  const key = label.toLowerCase() as keyof typeof LAMP;
  return LAMP[key] ?? LAMP.green;
}

/** A round lamp, dark or lit, optionally blinking or pulsing. */
export function lampStyle(color: string, mode: LampMode, size = 18): CSSProperties {
  const base: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
    display: "inline-block",
  };
  if (mode === "off") {
    return {
      ...base,
      background: "radial-gradient(circle at 34% 28%, var(--off1), var(--off2))",
      boxShadow: "inset 0 0 0 1px var(--offring)",
    };
  }
  const lit: CSSProperties = {
    ...base,
    background: `radial-gradient(circle at 34% 28%, color-mix(in oklab, ${color} 55%, white), ${color})`,
    boxShadow: `0 0 0 1px color-mix(in oklab, ${color} 70%, black), ` +
      `0 0 ${Math.round(size * 0.9)}px color-mix(in oklab, ${color} 60%, transparent)`,
  };
  if (mode === "blink") return { ...lit, animation: "lampBlink 0.9s steps(1,end) infinite" };
  if (mode === "pulse") return { ...lit, animation: "lampPulse 1s ease-in-out infinite" };
  return lit;
}

/**
 * The changing part of one segment in a segmented control.
 *
 * Size, padding and type live in `styles.css` with the rest of the static styling — they do not vary
 * with state, and holding them here made the touch target impossible to tune from one place. What is
 * left is only what the segment's state actually decides.
 *
 * `tint` colours an engaged segment as the thing it drives: the LED colour pickers read as the
 * colours they light rather than as five identical blue buttons.
 */
export function segStyle(
  { active, off, enabled, tint }: { active: boolean; off?: boolean; enabled: boolean; tint?: string },
): CSSProperties {
  // Engaged but not changeable is its own state, not "off": infrared is always on because the
  // PC-side OCR reads it, and rendering that button as an ordinary disabled one said the opposite.
  if (!enabled) {
    return active
      ? { background: "var(--off1)", color: "var(--text3)", boxShadow: "inset 0 0 0 1px var(--disline)" }
      : { background: "transparent", color: "var(--distext)" };
  }
  if (!active) return { background: "transparent", color: "var(--text2)" };
  if (off) {
    return {
      background: "linear-gradient(#5b636b, #4a5158)",
      color: "#fff",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.16)",
    };
  }
  const color = tint ?? ACCENT;
  return {
    background: `linear-gradient(color-mix(in oklab, ${color} 88%, white), ${color})`,
    color: "#fff",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22)",
  };
}

/**
 * The strip preview: the colour the strip is actually showing.
 *
 * The 919 walk established that the strip's three channels **mix additively** in the strip itself
 * rather than driving separate lamps — green and blue together read cyan, all three read white. So
 * the preview resolves whatever is commanded on down to the primaries it lights, and shows the one
 * colour that combination produces. An earlier version drew equal bands per colour and said in a
 * comment that a blend would be "a guess at what the hardware does"; the hardware has since answered,
 * and bands are now the guess.
 *
 * `mixes` is the vocabulary's colour → primaries map, passed through from the driver rather than
 * copied, so this cannot disagree with what a command actually sends.
 */
export function stripPreviewStyle(
  litPrimaries: string[],
  mixes: { color: string; primaries: string[] }[],
): CSSProperties {
  if (litPrimaries.length === 0) {
    return {
      background: "var(--dis)",
      boxShadow: "inset 0 1px 3px rgba(16,24,40,0.12)",
    };
  }
  const lit = new Set(litPrimaries);
  const match = mixes.find(({ primaries }) =>
    primaries.length === lit.size && primaries.every((primary) => lit.has(primary))
  );
  const color = match ? lampColor(match.color) : LAMP.white;
  return {
    background: `linear-gradient(color-mix(in oklab, ${color} 78%, white), ${color})`,
    boxShadow: `inset 0 1px 0 rgba(255,255,255,0.35), 0 0 16px color-mix(in oklab, ${color} 45%, transparent)`,
  };
}

/** Activity lines are toned by what produced them. */
export function toneOf(kind: string): Tone {
  switch (kind) {
    case "ok":
      return "ok";
    case "error":
    case "failed":
      return "bad";
    case "warned":
    case "door":
      return "warn";
    case "info":
      return "muted";
    default:
      return "normal";
  }
}

/**
 * The lamp colour a tone lights.
 *
 * One mapping rather than a ternary at each call site: the three that existed had drifted, and only
 * one of them distinguished a warning from a failure — so the same state showed amber in a toast and
 * red in the rail beside it.
 */
export function lampFor(tone: Tone): string {
  if (tone === "bad") return LAMP.red;
  if (tone === "warn") return LAMP.yellow;
  return LAMP.green;
}

/**
 * The badge class a tone renders as.
 *
 * `Tone` also names the two the activity log uses for lines nobody needs to act on. There is no
 * badge for those — a badge is a verdict — so they fall back to the neutral one rather than
 * producing a `badge--muted` with no rule behind it.
 */
export function badgeClass(tone: Tone): string {
  return tone === "ok" || tone === "warn" || tone === "bad" ? `badge badge--${tone}` : "badge";
}

/** The mark a tone puts in front of a badge, so it is not colour alone that carries the verdict. */
export function glyph(tone: Tone): string {
  if (tone === "ok") return "✓ ";
  if (tone === "warn") return "⚠ ";
  if (tone === "bad") return "✕ ";
  return "";
}

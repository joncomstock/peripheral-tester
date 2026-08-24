/**
 * The design's computed visuals.
 *
 * A lamp's appearance, a segmented button's state and the strip preview are all functions of what
 * has been commanded, so they are computed rather than expressed as class combinations. Everything
 * static lives in `styles.css`; only what varies is here.
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
} as const;

export const ACCENT = "#2f5fd0";

/** A USB id as the four lower-case hex digits every device page shows it in. */
export const hex = (value: number) => value.toString(16).padStart(4, "0");

/** Colour of the physical lamp a strip or semaphore control drives. */
export function lampColor(label: string): string {
  const key = label.toLowerCase() as keyof typeof LAMP;
  return LAMP[key] ?? LAMP.amber;
}

/** A round lamp, dark or lit, optionally blinking. */
export function lampStyle(color: string, mode: Action, size = 18): CSSProperties {
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
      background: "radial-gradient(circle at 34% 28%, #f4f6f8, #d8dde2)",
      boxShadow: "inset 0 0 0 1px rgba(16,24,40,0.12), inset 0 1px 1px rgba(255,255,255,0.85)",
    };
  }
  const lit: CSSProperties = {
    ...base,
    background: `radial-gradient(circle at 34% 28%, color-mix(in oklab, ${color} 55%, white), ${color})`,
    boxShadow: `0 0 0 1px color-mix(in oklab, ${color} 70%, black), ` +
      `0 0 ${Math.round(size * 0.9)}px color-mix(in oklab, ${color} 60%, transparent)`,
  };
  return mode === "blink" ? { ...lit, animation: "lampBlink 0.9s steps(1,end) infinite" } : lit;
}

/**
 * The changing part of one On / Blink / Off segment.
 *
 * Size, padding and type live in `styles.css` with the rest of the static styling — they do not vary
 * with state, and holding them here made the touch target impossible to tune from one place. What is
 * left is only what the segment's state actually decides.
 */
export function segStyle(
  { active, off, enabled }: { active: boolean; off?: boolean; enabled: boolean },
): CSSProperties {
  if (!enabled) return { background: "transparent", color: "#c1c6cc" };
  if (!active) return { background: "transparent", color: "#565d65" };
  if (off) {
    return {
      background: "linear-gradient(#5b636b, #4a5158)",
      color: "#fff",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.16)",
    };
  }
  return {
    background: `linear-gradient(color-mix(in oklab, ${ACCENT} 88%, white), ${ACCENT})`,
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
      background: "linear-gradient(#eceef1, #e3e6ea)",
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
export function toneOf(kind: string): string {
  switch (kind) {
    case "ok":
      return "ok";
    case "error":
    case "failed":
      return "bad";
    case "warned":
      return "warn";
    case "door":
      return "warn";
    case "info":
      return "muted";
    default:
      return "normal";
  }
}

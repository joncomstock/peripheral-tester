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
} as const;

export const ACCENT = "#2f5fd0";

/** Colour of the physical lamp a strip or semaphore control drives. */
export function lampColor(label: string): string {
  const key = label.toLowerCase() as keyof typeof LAMP;
  return LAMP[key] ?? LAMP.amber;
}

/** A round lamp, dark or lit, optionally blinking. */
export function lampStyle(color: string, mode: Action, size = 12): CSSProperties {
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

/** One segment of an On / Blink / Off control. */
export function segStyle(
  { active, off, first, enabled }: { active: boolean; off?: boolean; first?: boolean; enabled: boolean },
): CSSProperties {
  const base: CSSProperties = {
    height: 26,
    padding: "0 9px",
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: "0.01em",
    border: 0,
    borderLeft: first ? undefined : `1px solid ${enabled ? "#e2e6ea" : "#ebedf0"}`,
    cursor: enabled ? "pointer" : "not-allowed",
    whiteSpace: "nowrap",
    transition: "background 90ms ease, color 90ms ease",
  };
  if (!enabled) return { ...base, background: "transparent", color: "#c1c6cc" };
  if (!active) return { ...base, background: "transparent", color: "#565d65" };
  if (off) {
    return {
      ...base,
      background: "linear-gradient(#5b636b, #4a5158)",
      color: "#fff",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.16)",
    };
  }
  return {
    ...base,
    background: `linear-gradient(color-mix(in oklab, ${ACCENT} 88%, white), ${ACCENT})`,
    color: "#fff",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22)",
  };
}

/**
 * The strip preview: the colours currently commanded on, side by side.
 *
 * The real strip is one run of LEDs with three colour channels, so lighting two at once mixes them
 * on the kiosk. Showing them as equal bands rather than a blend keeps the preview a readout of what
 * was sent instead of a guess at what the hardware does with it.
 */
export function stripPreviewStyle(litColors: string[]): CSSProperties {
  if (litColors.length === 0) {
    return {
      background: "linear-gradient(#eceef1, #e3e6ea)",
      boxShadow: "inset 0 1px 2px rgba(16,24,40,0.10)",
    };
  }
  if (litColors.length === 1) {
    return {
      background: `linear-gradient(color-mix(in oklab, ${litColors[0]} 78%, white), ${litColors[0]})`,
      boxShadow: `inset 0 1px 0 rgba(255,255,255,0.35), 0 0 12px color-mix(in oklab, ${litColors[0]} 45%, transparent)`,
    };
  }
  const bands = litColors
    .map((color, index) => {
      const from = Math.round((index / litColors.length) * 100);
      const to = Math.round(((index + 1) / litColors.length) * 100);
      return `${color} ${from}%, ${color} ${to}%`;
    })
    .join(", ");
  return {
    background: `linear-gradient(90deg, ${bands})`,
    boxShadow: `inset 0 1px 0 rgba(255,255,255,0.35), 0 0 12px color-mix(in oklab, ${litColors[0]} 45%, transparent)`,
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

/**
 * Turns `/api/state`'s vocabulary into the controls the page lays out.
 *
 * The set of sections, the actions each takes and every channel number all come from the payload,
 * which the backend builds from the driver's own exported arrays and live channel map. Nothing here
 * keeps its own list, so this file cannot disagree with the driver about what the board has.
 *
 * Display names are the exception, and deliberately: `gppDispenser` is the driver's identifier, not
 * something to put in front of an operator. A key with no entry falls back to the identifier, so a
 * section the driver gains still appears.
 */

import type {
  Action,
  IndicatorSection,
  LedRequest,
  SemaphoreColor,
  Side,
  StripColor,
  Vocabulary,
} from "./api.ts";

const DISPLAY: Record<string, string> = {
  payment: "Payment terminal",
  cardReader: "Card reader",
  passportReader: "Passport reader",
  boardingPassPrinter: "Boarding pass printer",
  gppDispenser: "GPP dispenser",
  left: "Left side",
  right: "Right side",
  green: "Green",
  red: "Red",
  blue: "Blue",
  yellow: "Yellow",
};

export const nameOf = (key: string): string => DISPLAY[key] ?? key;

/**
 * A control's name with the part of the board it belongs to.
 *
 * Both the semaphore and the strip have a green, so a bare "Green" is ambiguous — as an accessible
 * name it left two buttons on the page indistinguishable. One rule, used for the control labels and
 * for the activity log, so the two can never describe the same command differently.
 */
export function fullName(section: string, qualifier?: string): string {
  if (!qualifier) return nameOf(section);
  const part = nameOf(qualifier).toLowerCase();
  if (section === "bagTagPrinter") return `Bag tag ${part}`;
  if (section === "semaphore") return `Semaphore ${part}`;
  if (section === "strip") return `Strip ${part}`;
  return `${nameOf(section)} ${part}`;
}

/** A `LedRequest` without its action — one per control. */
export type LedBase =
  | { section: IndicatorSection }
  | { section: "bagTagPrinter"; side: Side }
  | { section: "semaphore"; color: SemaphoreColor }
  | { section: "strip"; color: StripColor };

export interface Control {
  /** Stable identity, and the same scheme the backend's collision claimants use. */
  key: string;
  label: string;
  /** As the wire addresses it: `1`, `8`, or `6+1` for a colour lit from two lamps. */
  channel: string;
  /** Name including the part of the board, for the accessible name. `label` alone is ambiguous. */
  fullLabel: string;
  /** Actions this control may send. The strip has no blink on the wire, so it does not offer one. */
  actions: Action[];
  base: LedBase;
}

/**
 * Builds the request for one button.
 *
 * Throws on `strip` + `blink` rather than quietly coercing it: the strip's channels take only
 * Active/Inactive, {@link controlsFor} therefore never offers the button, and a silent substitution
 * would send a command the operator did not ask for while the log claimed otherwise.
 */
export function requestFor(base: LedBase, action: Action): LedRequest {
  if (base.section === "strip") {
    if (action === "blink") throw new Error("the strip has no blink command on the wire");
    return { ...base, action };
  }
  return { ...base, action };
}

export interface Controls {
  indicators: Control[];
  bagTag: Control[];
  semaphore: Control[];
  strip: Control[];
}

export function controlsFor(vocabulary: Vocabulary): Controls {
  const { actions } = vocabulary;
  // Derived, not hard-coded: if the driver ever gains a blink for the strip, this stops filtering.
  const stripActions = actions.filter((action) => action !== "blink");

  return {
    indicators: vocabulary.indicators.map(({ section, channel }) => ({
      key: `indicator:${section}`,
      label: nameOf(section),
      fullLabel: fullName(section),
      channel: String(channel),
      actions,
      base: { section },
    })),
    bagTag: vocabulary.sides.map(({ side, channel }) => ({
      key: `bagTag:${side}`,
      label: nameOf(side),
      fullLabel: fullName("bagTagPrinter", side),
      channel: String(channel),
      actions,
      base: { section: "bagTagPrinter", side },
    })),
    semaphore: vocabulary.semaphoreColors.map(({ color, channels }) => ({
      key: `semaphore:${color}`,
      label: nameOf(color),
      fullLabel: fullName("semaphore", color),
      // Yellow is red and green lit together, so it names both channels.
      channel: channels.join("+"),
      actions,
      base: { section: "semaphore", color },
    })),
    strip: vocabulary.stripColors.map(({ color, channel }) => ({
      key: `strip:${color}`,
      label: nameOf(color),
      fullLabel: fullName("strip", color),
      channel: String(channel),
      actions: stripActions,
      base: { section: "strip", color },
    })),
  };
}

/**
 * What was last commanded for each control.
 *
 * The board acknowledges commands; it never reports lamp state. So this is what the page asked for,
 * which is what a control panel can honestly show, and it is cleared whenever the port closes.
 */
export type Commanded = Record<string, Action>;

export const modeOf = (commanded: Commanded, key: string): Action => commanded[key] ?? "off";

/**
 * What the semaphore tower's red and green lamps are doing.
 *
 * Yellow is not a third lamp: it is red and green lit together, so a yellow command drives both.
 * The tower shows a colour's own state, or yellow's when that colour was not set directly.
 */
export function towerMode(commanded: Commanded, color: "red" | "green"): Action {
  const own = modeOf(commanded, `semaphore:${color}`);
  return own !== "off" ? own : modeOf(commanded, "semaphore:yellow");
}

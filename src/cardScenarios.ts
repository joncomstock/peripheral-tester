/**
 * The coherent ways to configure a V4KU read, as one click each.
 *
 * The four transaction settings do not vary independently: `direction` says *when* the stripe is
 * read — as the card goes in, or as it comes back out — and the two locks say when the card is
 * held. Pair "read on withdrawal" with "hold on insertion" and the card is captured on the way in
 * and never travels past the head again, so the read cannot happen. On the bench that reads as
 * `card present but unreadable` and a card stuck in the slot that has to be freed by hand.
 *
 * Nothing about that is guessable from four independent toggles, so the combinations that work are
 * named here and {@link incoherence} states the rule the page can check anything against. The manual
 * controls stay exactly as they were: a scenario sets them and runs the read, so what it chose is
 * visible on the same toggles and can be adjusted from there.
 *
 * @module
 */

import type { TransactionSetting } from "./api.ts";

/**
 * ISO tracks 1 and 2, as the bitmask.
 *
 * `@eai/omron`'s `DEFAULT_TRANSACTION` asks for these two and says why not all three: a payment
 * card generally carries no track 3, and asking for a track the card does not have fails the whole
 * read. Every scenario uses it.
 */
export const TRACKS_1_AND_2 = 3;

export interface CardScenario {
  readonly id: string;
  readonly label: string;
  /** One line, for underneath the button: what the operator should do with the card. */
  readonly hint: string;
  readonly setting: TransactionSetting;
  /** Whether the card is still held when the read finishes, so the page can offer a release. */
  readonly retains: boolean;
}

/**
 * Why this configuration cannot read, or null if it can.
 *
 * The message is shown to whoever is standing at the reader, so it says what will happen to the
 * card rather than naming the fields.
 */
export function incoherence(setting: TransactionSetting): string | null {
  // `@eai/omron` reports the device refusing `none` in every capture taken, and a refused setting
  // command costs the driver a re-synchronised cycle and then faults its listen loop.
  if (setting.direction === "none") {
    return "The device refuses a read direction of None — choose insertion or withdrawal.";
  }
  if (setting.tracks === 0) return "No track is selected, so there is nothing to read.";
  if (setting.direction === "back" && setting.insertionLock) {
    return "The card is held on insertion but only read on withdrawal, so it can never travel past the head. It will be captured and unreadable.";
  }
  return null;
}

const base = { tracks: TRACKS_1_AND_2, insertionLock: false, pullOutLock: false } as const;

export const CARD_SCENARIOS: readonly CardScenario[] = [
  {
    id: "insertion",
    label: "Read on insertion",
    hint: "Insert the card fully in one steady motion. It reads going in and stays free.",
    setting: { ...base, direction: "insertion" },
    retains: false,
  },
  {
    id: "insertionRetain",
    label: "Read and retain",
    hint: "Insert the card fully. It reads going in, then the reader holds it.",
    setting: { ...base, direction: "insertion", insertionLock: true },
    retains: true,
  },
  {
    id: "withdrawal",
    label: "Read on withdrawal",
    hint: "Insert the card fully, then pull it out in one steady motion. It reads on the way out.",
    setting: { ...base, direction: "back" },
    retains: false,
  },
  {
    id: "withdrawalRetain",
    label: "Read on withdrawal, retain",
    hint: "Insert, then pull out. It reads on the way out and the reader holds it there.",
    setting: { ...base, direction: "back", pullOutLock: true },
    retains: true,
  },
];

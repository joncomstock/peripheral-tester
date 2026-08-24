/**
 * Display formatting shared by the device pages.
 *
 * Separate from `look.ts`, which is the design's *computed visuals* — what a lamp or a segment looks
 * like given what was commanded. Turning a number into the text beside it is neither computed nor
 * visual, and `look.ts` says in its own header that only what varies belongs there.
 */

/** One half of a USB id — vendor or product — as the four lower-case hex digits a device page shows. */
export const usbId = (value: number) => value.toString(16).padStart(4, "0");

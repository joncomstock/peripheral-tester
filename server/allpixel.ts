/**
 * The ManiacalLabs AllPixel, as one device of the tester: the controller behind an Embross V1's
 * 120 LEDs, the ring round the base and the strip across the top of the monitor.
 *
 * What hardware-libs' driver reaches, and so what this tests: the board answering its id, and the
 * string lit by the Embross V1 layout's named regions and corners. The board never reports its
 * LEDs, so the page shows what was commanded, read back from the driver's own pixel buffer.
 *
 * Left out on purpose: `configure` (writes the LED type and count to the board's memory and
 * restarts it) and `setId` (writes its memory). Both persist on the board.
 *
 * @module
 */

import type { Transport } from "@eai/models";
import { AllPixel, ALLPIXEL_PRODUCT_ID, ALLPIXEL_VENDOR_ID, connectAllPixel, EMBROSS_V1_LAYOUT, Reply } from "@eai/maniacal-labs/allpixel";
import type { Rgb } from "@eai/maniacal-labs/allpixel";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("allpixel", kind, text);

// ---------------------------------------------------------------------------------------------
// A fake board, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

const COMMAND = { PIXEL_DATA: 2, GET_ID: 4 } as const;

/**
 * Speaks the AllPixel's serial protocol: every command `[cmd, lenLo, lenHi, payload…]` answered with
 * one byte. GET_ID answers the id, a frame of any length but the stored 120 LEDs is refused, and a
 * quiet line reads as `null`, as the serial transports report it.
 */
class MockAllPixel implements Transport {
  isOpen = true;
  #inbound: number[] = [];

  write(data: Uint8Array): Promise<void> {
    const length = data[1] | (data[2] << 8);
    if (data[0] === COMMAND.GET_ID) this.#inbound.push(7);
    else if (data[0] === COMMAND.PIXEL_DATA && length !== EMBROSS_V1_LAYOUT.ledCount * 3) this.#inbound.push(Reply.WRONG_LENGTH);
    else this.#inbound.push(Reply.OK);
    return Promise.resolve();
  }

  async read(maxLength: number): Promise<Uint8Array | null> {
    if (!this.#inbound.length) await new Promise((resolve) => setTimeout(resolve, 2));
    return this.#inbound.length ? new Uint8Array(this.#inbound.splice(0, maxLength)) : null;
  }

  readUntil(): Promise<Uint8Array | null> {
    return Promise.reject(new Error("the board answers in single bytes"));
  }

  close(): Promise<void> {
    this.isOpen = false;
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

/** The colours the page offers, named as `src/look.ts` names its lamps. */
const COLORS: Record<string, Rgb> = {
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  amber: [255, 120, 0],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
};

/** The layout's regions, and its four corners as one more zone. */
const ZONES: Record<string, readonly number[]> = {
  ...EMBROSS_V1_LAYOUT.regions,
  corners: Object.values(EMBROSS_V1_LAYOUT.corners),
};

export type Status = "closed" | "opening" | "open";

let lights: AllPixel | null = null;
let status: Status = "closed";
let mock = false;
let boardId: number | null = null;

const usbId = [ALLPIXEL_VENDOR_ID, ALLPIXEL_PRODUCT_ID].map((id) => id.toString(16).padStart(4, "0")).join(":");

/** What each zone was last set to: a colour's name, "off", or "mixed" when its LEDs differ. */
function zoneColors(): Record<string, string> {
  const pixels = lights?.pixels;
  const names = Object.entries(COLORS);
  return Object.fromEntries(
    Object.entries(ZONES).map(([zone, leds]) => {
      if (!pixels) return [zone, "off"];
      const rgbs = new Set(leds.map((led) => [...pixels.subarray(led * 3, led * 3 + 3)].join(",")));
      if (rgbs.size > 1) return [zone, "mixed"];
      const [only] = rgbs;
      if (only === "0,0,0") return [zone, "off"];
      return [zone, names.find(([, rgb]) => rgb.join(",") === only)?.[0] ?? "mixed"];
    }),
  );
}

export const state = () => ({
  status,
  mock,
  usbId,
  boardId,
  ledCount: EMBROSS_V1_LAYOUT.ledCount,
  /** The vocabularies, so the page keeps no copy. */
  colors: Object.keys(COLORS),
  zones: Object.keys(ZONES),
  /** Commanded, not reported. */
  lit: zoneColors(),
});

const tell = () => announce("allpixel", state());

export function configure(options: { mock: boolean }): void {
  // A device opened in one mode must never carry on into the other.
  if (status !== "closed") throw new Error("Disconnect before changing mode");
  mock = options.mock;
  tell();
}

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();
  log("info", mock ? "Opening mock AllPixel" : `Opening ${usbId} over USB serial`);
  try {
    lights = mock ? await AllPixel.openWithTransport(new MockAllPixel(), {}, "AllPixel:mock") : await connectAllPixel();
    boardId = await lights.getId();
    // A board keeps its last frame across host sessions; start from a known dark string.
    await lights.allOff();
  }
  catch (err) {
    await lights?.close().catch(() => {});
    lights = null;
    boardId = null;
    status = "closed";
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  status = "open";
  tell();
  log("ok", `Board ${boardId} answered; ${EMBROSS_V1_LAYOUT.ledCount} LEDs, all off`);
}

export async function disconnect(): Promise<void> {
  const open = lights;
  if (!open) return;
  lights = null;
  status = "closed";
  // The LEDs keep their last colours when the port is released, so they are turned off first.
  await open.allOff().catch(() => {});
  await open.close().catch(() => {});
  boardId = null;
  tell();
  log("info", "AllPixel released, LEDs off");
}

/** Runs a command; a board that went away closes the session rather than leaving it claiming to be open. */
async function using(work: (open: AllPixel) => Promise<void>): Promise<void> {
  if (!lights) throw new Error("Not connected");
  const open = lights;
  try {
    await work(open);
  }
  catch (err) {
    if (!open.isOpen && lights === open) {
      lights = null;
      boardId = null;
      status = "closed";
      tell();
      log("error", "The AllPixel stopped answering. Reconnect to continue.");
    }
    throw err;
  }
  tell();
}

function zoneOf(body: Record<string, unknown>): string {
  const zone = body.zone;
  if (typeof zone !== "string" || !Object.hasOwn(ZONES, zone)) throw new Error(`'${zone}' is not a zone`);
  return zone;
}

export const actions: Record<string, (body: Record<string, unknown>) => unknown> = {
  /** `{ zone, color }`: one zone to a named colour, or "off"; the rest keep theirs. */
  fill: async (body) => {
    const zone = zoneOf(body);
    const color = body.color;
    if (color !== "off" && (typeof color !== "string" || !Object.hasOwn(COLORS, color))) throw new Error(`'${color}' is not a colour`);
    await using((open) => open.setLeds(ZONES[zone], color === "off" ? [0, 0, 0] : COLORS[color]));
    log("sent", `${zone} ${color}`);
  },
  /** Every LED off, the hidden ones inside the cabinet included. */
  "all-off": async () => {
    await using((open) => open.allOff());
    log("sent", "All off");
  },
};

/**
 * The IER S33380 light board, as one device of the tester.
 *
 * Claims the board's USB interface for as long as it is connected. Only the process holding the
 * interface can drive the board, which is why the browser never speaks to it directly.
 *
 * @module
 */

import { listenForWarnings } from "./driverWarnings.ts";
import type { Transport } from "@eai/models";
import {
  ACTIONS,
  IER_S33380_DEFAULTS,
  IER_VENDOR_ID,
  IERS33380,
  INDICATOR_SECTIONS,
  S33380_PRODUCT_ID,
  SEMAPHORE_COLORS,
  SIDES,
  STRIP_COLORS,
  STRIP_MIX,
} from "@eai/ier/s33380";
import type { LedRequest } from "@eai/ier/s33380";
import { aiCollisions } from "./collisions.ts";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("lightboard", kind, text);

// ---------------------------------------------------------------------------------------------
// A fake board, for driving the page without a kiosk.
// ---------------------------------------------------------------------------------------------

/**
 * Answers every command with a plausible token and reports a door when asked to.
 *
 * The doors are driven from the page rather than a timer: this is a control panel, and a door that
 * flapped on its own every few seconds would fill the activity log with events nobody caused.
 */
class MockBoard implements Transport {
  isOpen = true;
  #inbound: Uint8Array[] = [];
  #enc = new TextEncoder();
  #replies = 0;

  /** Push an input report for a door channel, as the real board would when a switch moves. */
  reportDoor(channel: number, open: boolean): void {
    this.#inbound.push(
      this.#enc.encode(`\x02/L;${channel}=${open ? "A" : "I"}\x03`),
    );
  }

  write(data: Uint8Array): Promise<void> {
    // Stripped by code point, not by regex: a pattern holding the raw STX/ETX bytes evades both
    // `no-control-regex` (which only sees escape sequences) and review (they are invisible).
    const framed = new TextDecoder().decode(data);
    const start = framed.charCodeAt(0) === 0x02 ? 1 : 0;
    const end = framed.charCodeAt(framed.length - 1) === 0x03 ? framed.length - 1 : framed.length;
    const body = framed.slice(start, end);
    // Every third reply echoes the parameters (`AI;3=O@`) instead of answering bare (`AI@`). Both
    // shapes are real, the driver accepts either and warns naming the token it saw, and the warning
    // reaches the activity log — so that path is exercised before anyone is standing at a kiosk.
    this.#replies += 1;
    const token = this.#replies % 3 === 0 ? body : body.slice(0, 2);
    this.#inbound.push(this.#enc.encode(`\x02${token}@\x03`));
    return Promise.resolve();
  }

  read(): Promise<Uint8Array | null> {
    const next = this.#inbound.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => setTimeout(() => resolve(null), 50));
  }

  readUntil(): Promise<Uint8Array | null> {
    throw new Error("the light board frames its own reads");
  }

  close(): Promise<void> {
    this.isOpen = false;
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export type Status = "closed" | "opening" | "open";

let board: IERS33380 | null = null;
let mockBoard: MockBoard | null = null;
let status: Status = "closed";
let mock = false;

const doors: Record<"upper" | "lower", string> = {
  upper: "closed",
  lower: "closed",
};

export function configure(options: { mock: boolean }): void {
  mock = options.mock;
}

/**
 * The board's USB identity, fixed rather than offered.
 *
 * It used to be a COM port this page asked a person for. The board is a vendor-specific bulk device
 * — `@eai/ier` claims `171c:00a0` with libusb — so there is nothing left to choose, and `open()`
 * finds the first one attached.
 */
const usb = { vendorId: IER_VENDOR_ID, productId: S33380_PRODUCT_ID };

export const state = () => ({ status, usb, mock, doors: { ...doors } });

const tell = () => announce("lightboard", state());

function wire(opened: IERS33380): void {
  opened.on("door", (event: { door: "upper" | "lower"; state: string }) => {
    doors[event.door] = event.state;
    log(
      "door",
      `${event.door[0].toUpperCase()}${event.door.slice(1)} door ${event.state}`,
    );
    tell();
  });
  // A report from an input channel that is not a configured door — on the office 919, J17 is a
  // media sensor in the boarding-pass printer's output. The driver names it from `config.inputs`
  // and reports it here rather than on `data`, so without this the sensor is simply silent.
  opened.on("input", (event: { channel: number; name: string | null; state: string }) => {
    log("data", `Input ${event.name ?? `channel ${event.channel}`} ${event.state}`);
  });
  opened.on("data", (text: string) => log("data", text));
  opened.on("error", (err: Error) => log("error", err.message));
  opened.on("disconnect", () => {
    log("error", "The board stopped reporting. Reconnect to continue.");
    board = null;
    mockBoard = null;
    status = "closed";
    tell();
  });
}

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();

  const id = `${usb.vendorId.toString(16).padStart(4, "0")}:${usb.productId.toString(16).padStart(4, "0")}`;
  const name = mock ? "IERS33380:mock" : `IERS33380:${id}`;
  log("info", mock ? "Opening a fake board" : `Claiming ${id} over USB`);

  try {
    if (mock) {
      mockBoard = new MockBoard();
      board = await IERS33380.openWithTransport(mockBoard, undefined, name);
    }
    else {
      // No arguments: the identity is the driver's, and a bare open() takes the first board on the
      // machine. On Windows the interface has to be bound to WinUSB for libusb to claim it.
      board = await IERS33380.open();
    }
  }
  catch (err) {
    status = "closed";
    board = null;
    mockBoard = null;
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }

  listenForWarnings("lightboard", name);
  wire(board);
  status = "open";
  tell();
  log("ok", "Board acknowledged handshake");
}

export async function disconnect(): Promise<void> {
  const open = board;
  if (!open) return;
  board = null;
  mockBoard = null;
  status = "closed";
  // Leave the board dark: a kiosk left with lamps lit is the mistake this exists to avoid.
  try {
    await open.allOff();
  }
  catch { /* a board that is already unreachable cannot be darkened */ }
  await open.close();
  tell();
  log("info", "Board released");
}

/**
 * The board's vocabulary and channel map.
 *
 * Built from the driver's own exported arrays, so the page cannot offer a section the driver does
 * not have.
 *
 * The channel map is the shipped default rather than the open board's live one: the driver keeps
 * its config private now, and nothing here ever passes an override, so the two cannot differ. Give
 * this page a way to send a custom `LightboardConfig` and that stops being true — read it back off
 * whatever this sends rather than asking the board.
 */
export function vocabulary() {
  const config = IER_S33380_DEFAULTS;
  return {
    actions: ACTIONS,
    // Only the sections this board actually has a lamp for. The channel map is `Partial`: a
    // section absent from it is not fitted on the unit, the driver rejects it by name, and offering
    // a button for it would be a dead control with an undefined channel under it.
    indicators: INDICATOR_SECTIONS.flatMap((section) => {
      const channel = config.indicators[section];
      return channel === undefined ? [] : [{ section, channel }];
    }),
    sides: SIDES.map((side) => ({ side, channel: config.bagTag[side] })),
    // A strip colour is one or more primaries lit together — the channels mix additively in the
    // strip itself, so cyan is green and blue rather than wiring of its own.
    stripColors: STRIP_COLORS.map((color) => ({
      color,
      primaries: STRIP_MIX[color],
      channels: STRIP_MIX[color].map((primary) => config.strip[primary]),
    })),
    semaphoreColors: SEMAPHORE_COLORS.map((color) => ({
      color,
      channels: config.semaphore[color],
    })),
    doorChannels: Object.entries(config.doors).map(([channel, door]) => ({
      channel: Number(channel),
      door,
    })),
    collisions: aiCollisions(config),
  };
}

/** Sections sharing an indicator channel, so a command that may drive two lamps says so once. */
function sharedNote(request: LedRequest): string | null {
  const id = request.section === "bagTagPrinter"
    ? `bagTag:${request.side}`
    : request.section === "semaphore"
    ? `semaphore:${request.color}`
    : request.section === "strip"
    ? null
    : `indicator:${request.section}`;
  if (id === null) return null;

  for (const collision of vocabulary().collisions) {
    const mine = collision.claimants.find((claimant) => claimant.id === id);
    if (!mine) continue;
    const others = collision.claimants.filter((claimant) => claimant.id !== id).map((c) => c.label);
    return `ch ${collision.channel} is also ${others.join(" and ")}`;
  }
  return null;
}

export async function led(request: LedRequest): Promise<void> {
  const open = board;
  if (!open) throw new Error("Not connected");
  await open.ledControl(request);
  log("sent", JSON.stringify(request));
  const note = sharedNote(request);
  if (note) log("info", note);
}

export async function allOff(): Promise<void> {
  const open = board;
  if (!open) throw new Error("Not connected");
  await open.allOff();
  log("ok", "All off");
}

/**
 * Move a simulated door switch.
 *
 * On a real kiosk the operator moves the door by hand; with no kiosk in front of you the page has to
 * be able to move it instead, or the reporting path is never seen.
 */
export function simulateDoor(door: "upper" | "lower"): void {
  if (!mock || !mockBoard) {
    throw new Error("Only a mock board has simulated doors");
  }
  const entry = vocabulary().doorChannels.find((candidate) => candidate.door === door);
  if (!entry) throw new Error(`No input channel maps to the ${door} door`);
  mockBoard.reportDoor(entry.channel, doors[door] !== "open");
}

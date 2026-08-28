/**
 * The IER S33380 light board, as one device of the tester.
 *
 * Owns the COM port for as long as it is connected. Only the process holding the COM handle can
 * drive the board, which is why the browser never speaks to it directly.
 *
 * @module
 */

import { BaseHandler } from "@std/log";
import type { LogRecord } from "@std/log";
import { attachHandler } from "@eai/logging-ts";
import type { Transport } from "@eai/models";
import {
  ACTIONS,
  IER_S33380_DEFAULTS,
  IERS33380,
  INDICATOR_SECTIONS,
  SEMAPHORE_COLORS,
  SIDES,
  STRIP_COLORS,
  STRIP_MIX,
} from "@eai/ier/s33380";
import type { LedRequest } from "@eai/ier/s33380";
import { aiCollisions } from "./collisions.ts";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("lightboard", kind, text);

/**
 * The port to offer when nobody has picked one.
 *
 * `@eai/ier` exported this until the board gained a USB-serial transport alongside the COM one, at
 * which point a single default port stopped meaning anything to the driver. It still means
 * something to this page, which asks a person for a port name: COM14 is where the board sits on the
 * 919 the channel map was walked on, and it is a prefill, not a pin.
 */
const DEFAULT_PORT = "COM14";

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
    this.#inbound.push(this.#enc.encode(`\x02/L;${channel}=${open ? "A" : "I"}\x03`));
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
let portName: string;
let mock = false;

const doors: Record<"upper" | "lower", string> = { upper: "closed", lower: "closed" };

export function configure(options: { mock: boolean; portName?: string }): void {
  mock = options.mock;
  portName = mock ? "mock" : (options.portName ?? DEFAULT_PORT);
}

export const state = () => ({ status, portName, mock, doors: { ...doors } });

const tell = () => announce("lightboard", state());

/**
 * Logger names already carrying our handler.
 *
 * `attachHandler` pushes onto the logger's handler list, so reconnecting to the same port would
 * attach a second copy and every driver warning would arrive twice.
 */
const attached = new Set<string>();

/**
 * The driver's own warnings, onto the page.
 *
 * A mismatched acknowledgement is reported through the driver's logger, which means this process's
 * stdout — where an operator looking at the board and the page has no reason to be watching.
 */
class WarningsToPage extends BaseHandler {
  /** Warnings only: the driver's `error` calls already reach the page through its `error` event. */
  override handle(entry: LogRecord): void {
    if (entry.levelName === "WARN") log("warned", entry.msg);
  }

  /** Abstract on the base class, and unreachable here: `handle` never enters the formatting path. */
  override log(): void {
    throw new Error("unreachable");
  }
}

function listen(name: string): void {
  if (attached.has(name)) return;
  attachHandler(name, new WarningsToPage("WARN"));
  attached.add(name);
}

function wire(opened: IERS33380): void {
  opened.on("door", (event: { door: "upper" | "lower"; state: string }) => {
    doors[event.door] = event.state;
    log("door", `${event.door[0].toUpperCase()}${event.door.slice(1)} door ${event.state}`);
    tell();
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

export async function connect(requested?: string): Promise<void> {
  if (status !== "closed") return;
  portName = mock ? "mock" : (requested ?? portName).trim().toUpperCase() || DEFAULT_PORT;
  status = "opening";
  tell();
  log("info", `Opening ${portName} at 9600 8N1`);

  const name = `IERS33380:${portName}`;
  try {
    if (mock) {
      mockBoard = new MockBoard();
      board = await IERS33380.openWithTransport(mockBoard, undefined, name);
    }
    else {
      // `open()` is now the USB-serial door and wants a vendor/product pair; `openPort()` is the
      // one that takes a COM port, which is what IER's own bus driver presents on a 919.
      board = await IERS33380.openPort({ port: portName });
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

  listen(name);
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
  log("info", `${portName} released`);
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
    indicators: INDICATOR_SECTIONS.map((section) => ({ section, channel: config.indicators[section] })),
    sides: SIDES.map((side) => ({ side, channel: config.bagTag[side] })),
    // A strip colour is one or more primaries lit together — the channels mix additively in the
    // strip itself, so cyan is green and blue rather than wiring of its own.
    stripColors: STRIP_COLORS.map((color) => ({
      color,
      primaries: STRIP_MIX[color],
      channels: STRIP_MIX[color].map((primary) => config.strip[primary]),
    })),
    semaphoreColors: SEMAPHORE_COLORS.map((color) => ({ color, channels: config.semaphore[color] })),
    doorChannels: Object.entries(config.doors).map(([channel, door]) => ({ channel: Number(channel), door })),
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
  if (!mock || !mockBoard) throw new Error("Only a mock board has simulated doors");
  const entry = vocabulary().doorChannels.find((candidate) => candidate.door === door);
  if (!entry) throw new Error(`No input channel maps to the ${door} door`);
  mockBoard.reportDoor(entry.channel, doors[door] !== "open");
}

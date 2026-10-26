/**
 * The DESKO Penta Gen4, as one device of the tester: the 919's passport reader.
 *
 * What hardware-libs' driver reaches, and so what this tests: the barcode engine behind the glass
 * (boarding passes), document placed / flipped / removed on the glass, the status LED triangle, the
 * external LED strips, the buzzer and the white flood. It does not read a passport's MRZ or images.
 * The configuration XML, symbology restriction and reset are left out on purpose: each restarts the
 * device, which drops off USB for 15 to 20 seconds.
 *
 * A barcode is a boarding pass, which carries a passenger's name and booking. The log is told one
 * was read and its symbology, never its text; the text goes to the page in state.
 *
 * @module
 */

import type { Transport } from "@eai/models";
import {
  DESKO_VENDOR_ID,
  DeskoPenta,
  EXTERNAL_LED_COLORS,
  FLOOD_LEVELS,
  floodLevel,
  floodLevelValue,
  LED_COLORS,
  PENTA_PRODUCT_ID,
} from "@eai/desko/penta";
import type { Barcode, DocumentEvent, ExternalLedColor, LedColor } from "@eai/desko/penta";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("penta", kind, text);

// ---------------------------------------------------------------------------------------------
// A fake scanner, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

const FRAME = 64;
const OP = {
  SYSTEM_INFO: 0x05,
  HARDWARE_CONFIG: 0x06,
  SET_HARDWARE_CONFIG: 0x07,
  BARCODE: 0x0b,
  PROX_SETTINGS: 0x1e,
  SET_PROX_SETTINGS: 0x1f,
  NOTIFICATION: 0x2a,
  ENGINE_REVISION: 0x2c,
} as const;

/** A fabricated boarding pass (IATA BCBP), PDF417: no real passenger or booking. */
const DEMO_BOARDING_PASS = "M1SANDOVAL/MARIA      EABC123 YYZYVRAC 0123 299Y012A0042 100";

/**
 * Speaks enough of the Penta's USB protocol to drive the real driver over its two pipes: 64-byte
 * command, response and notification frames on `cmd`, payloads on `data`. A response echoes the
 * opcode with a status in byte 1 and any payload length as a u32 at offset 48; a command carrying a
 * payload is answered once, then confirmed again after the payload arrives.
 */
class MockPenta {
  #frames: Uint8Array[] = [];
  #payloads: Uint8Array[] = [];
  /** The opcode whose payload is due on `data`, to confirm when it lands. */
  #awaitingPayload: number | null = null;
  #barcode: string | null = null;
  #flood = 50;
  #open = true;
  #enc = new TextEncoder();

  readonly cmd: Transport = {
    isOpen: true,
    write: (frame: Uint8Array) => this.#command(frame),
    read: () => this.#take(this.#frames),
    readUntil: () => Promise.reject(new Error("the Penta frames its own reads")),
    close: () => this.#close(),
  } as unknown as Transport;

  readonly data: Transport = {
    isOpen: true,
    write: (payload: Uint8Array) => this.#payload(payload),
    read: () => this.#take(this.#payloads),
    readUntil: () => Promise.reject(new Error("the Penta frames its own reads")),
    close: () => this.#close(),
  } as unknown as Transport;

  /** A document lands on the glass, optionally with a boarding pass for the engine to decode. */
  place(boardingPass: boolean): void {
    if (boardingPass) this.#barcode = `\x02]L2${DEMO_BOARDING_PASS}\x03`;
    this.#notify({ present: true, barcode: boardingPass });
  }

  flip(): void {
    this.#notify({ flipped: true });
  }

  remove(): void {
    this.#notify({ removed: true });
  }

  #notify(what: { present?: boolean; barcode?: boolean; flipped?: boolean; removed?: boolean }): void {
    const frame = new Uint8Array(FRAME);
    frame[0] = OP.NOTIFICATION;
    if (what.flipped) frame[22] = 1;
    if (what.barcode) frame[48] = 1;
    if (what.present) frame[52] = 1;
    if (what.removed) frame[60] = 1;
    this.#frames.push(frame);
  }

  #respond(opcode: number, status: number, payload?: Uint8Array): void {
    const frame = new Uint8Array(FRAME);
    frame[0] = opcode;
    frame[1] = status;
    if (payload) {
      new DataView(frame.buffer).setUint32(48, payload.length, true);
      this.#payloads.push(payload);
    }
    this.#frames.push(frame);
  }

  #command(frame: Uint8Array): Promise<void> {
    const opcode = frame[0];
    switch (opcode) {
      case OP.SYSTEM_INFO:
        this.#respond(opcode, 0, this.#enc.encode("BF525-MOCK\x00Oct 26 2026\x0012:00:00\x00"));
        break;
      case OP.HARDWARE_CONFIG: {
        const config = new Uint8Array(158);
        config[124] = 4; // barcode reporting armed
        this.#respond(opcode, 0, config);
        break;
      }
      case OP.BARCODE:
        if (this.#barcode) this.#respond(opcode, 0, this.#enc.encode(this.#barcode));
        else this.#respond(opcode, 1);
        break;
      case OP.PROX_SETTINGS:
        this.#respond(opcode, 0, this.#enc.encode(`IluVisBrightness ${this.#flood}\n`.padEnd(64, "\n")));
        break;
      case OP.ENGINE_REVISION:
        this.#respond(opcode, 0, this.#enc.encode("N56XX-MOCK REV 1.00"));
        break;
      case OP.SET_HARDWARE_CONFIG:
      case OP.SET_PROX_SETTINGS:
        this.#awaitingPayload = opcode;
        this.#respond(opcode, 0);
        break;
      default:
        // The buzzer, the external strips: plain acknowledgements. Nothing else is sent by the page.
        this.#respond(opcode, 0);
    }
    return Promise.resolve();
  }

  #payload(payload: Uint8Array): Promise<void> {
    const opcode = this.#awaitingPayload;
    this.#awaitingPayload = null;
    if (opcode === OP.SET_PROX_SETTINGS) {
      const match = new TextDecoder().decode(payload).match(/IluVisBrightness (\d+)/);
      if (match) this.#flood = Number(match[1]);
    }
    if (opcode !== null) this.#respond(opcode, 0);
    return Promise.resolve();
  }

  #take(queue: Uint8Array[]): Promise<Uint8Array | null> {
    if (!this.#open) return Promise.reject(new Error("closed"));
    const next = queue.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => setTimeout(() => resolve(null), 30));
  }

  #close(): Promise<void> {
    this.#open = false;
    (this.cmd as { isOpen: boolean }).isOpen = false;
    (this.data as { isOpen: boolean }).isOpen = false;
    return Promise.resolve();
  }
}

/** ICAO 9303 check digit: weights 7, 3, 1 over digits, letters as 10..35, and filler as 0. */
function checkDigit(field: string): string {
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    const c = field[i];
    const value = c === "<" ? 0 : c >= "A" ? c.charCodeAt(0) - 55 : Number(c);
    sum += value * [7, 3, 1][i % 3];
  }
  return String(sum % 10);
}

/**
 * A specimen passport for the mock: what a passport read would show. "UTO" is ICAO's own fictional
 * issuing state, and the check digits are computed, so the MRZ is well formed and obviously not real.
 * **The Penta driver does not read an MRZ**, so this exists only in mock mode, for a demo; on real
 * hardware nothing fills it.
 */
function specimenPassport() {
  const number = "XA1234567";
  const birth = "900314";
  const expiry = "310930";
  const personal = "<".repeat(14);
  const composite = number + checkDigit(number) + birth + checkDigit(birth) + expiry + checkDigit(expiry) + personal +
    checkDigit(personal);
  const line1 = "P<UTOSANDOVAL<<MARIA".padEnd(44, "<");
  const line2 = number + checkDigit(number) + "UTO" + birth + checkDigit(birth) + "F" + expiry + checkDigit(expiry) + personal +
    checkDigit(personal) + checkDigit(composite);
  return {
    mrz: [line1, line2],
    documentType: "Passport",
    issuingState: "UTO (Utopia, ICAO specimen)",
    surname: "SANDOVAL",
    givenNames: "MARIA",
    documentNumber: number,
    nationality: "UTO",
    birthDate: "1990-03-14",
    sex: "F",
    expiryDate: "2031-09-30",
  };
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export type Status = "closed" | "opening" | "open";

let penta: DeskoPenta | null = null;
let mockPenta: MockPenta | null = null;
let status: Status = "closed";
let mock = false;
/** The last document event. Edge-triggered: unknown until the first one after connecting. */
let document: DocumentEvent | null = null;
let barcode: { symbology: string | null; text: string } | null = null;
/** A mock passport's data page while it is on the glass. Mock mode only: see {@link specimenPassport}. */
let passport: ReturnType<typeof specimenPassport> | null = null;
/** What was last commanded; the device does not report its LEDs. */
let statusLed: { mode: "on" | "flash"; color: LedColor } | null = null;
let externalLed: ExternalLedColor | "off" = "off";
let flood: number | null = null;

const usbId = [DESKO_VENDOR_ID, PENTA_PRODUCT_ID].map((id) => id.toString(16).padStart(4, "0")).join(":");

export const state = () => ({
  status,
  mock,
  passport,
  usbId,
  document,
  barcode,
  statusLed,
  externalLed,
  /** The flood as a 0..levels step, which is what the page's slider moves. */
  floodLevel: flood === null ? null : floodLevel(flood),
  floodLevels: FLOOD_LEVELS,
  /** The driver's own vocabularies, so the page keeps no copy. */
  ledColors: LED_COLORS,
  externalLedColors: EXTERNAL_LED_COLORS,
});

const tell = () => announce("penta", state());

export function configure(options: { mock: boolean }): void {
  // A device opened in one mode must never carry on into the other.
  if (status !== "closed") throw new Error("Disconnect before changing mode");
  mock = options.mock;
  tell();
}

function wire(opened: DeskoPenta): void {
  opened.on("document", (event: DocumentEvent) => {
    document = event;
    if (event === "removed") passport = null;
    log("info", `Document ${event}`);
    tell();
  });
  opened.on("barcode", (read: Barcode) => {
    barcode = { symbology: read.symbology, text: read.text };
    // The symbology and length, never the text: a boarding pass carries a passenger's name.
    log("ok", `Barcode read — ${read.symbology ?? "no symbology"}, ${read.text.length} characters`);
    tell();
  });
  opened.on("error", (err: Error) => log("error", err.message));
  opened.on("disconnect", () => {
    if (penta !== opened) return;
    penta = null;
    mockPenta = null;
    status = "closed";
    log("error", "The scanner stopped reporting. Reconnect to continue.");
    tell();
  });
}

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();
  log("info", mock ? "Opening mock Penta" : `Opening ${usbId} over USB`);
  try {
    if (mock) {
      mockPenta = new MockPenta();
      penta = await DeskoPenta.openWithTransport(mockPenta.cmd, mockPenta.data, undefined, "DeskoPenta:mock");
    }
    else {
      penta = await DeskoPenta.open();
    }
    wire(penta);
    flood = await penta.floodBrightness();
  }
  catch (err) {
    await penta?.close().catch(() => {});
    penta = null;
    mockPenta = null;
    status = "closed";
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  status = "open";
  tell();
  log("ok", "Scanner answered; barcode reporting armed");
}

export async function disconnect(): Promise<void> {
  const open = penta;
  if (!open) return;
  penta = null;
  status = "closed";
  // Leave it dark. The strips persist across host disconnects, so they are turned off explicitly.
  try {
    await open.setStatusLed({ mode: "off" });
    await open.setExternalLed("off");
  }
  catch { /* a scanner already unreachable cannot be darkened */ }
  await open.close();
  mockPenta = null;
  document = null;
  passport = null;
  barcode = null;
  statusLed = null;
  externalLed = "off";
  flood = null;
  tell();
  log("info", "Scanner released");
}

function held(): DeskoPenta {
  if (!penta) throw new Error("Not connected");
  return penta;
}

export async function setStatusLed(mode: "on" | "flash" | "off", color?: LedColor): Promise<void> {
  if (mode === "off") await held().setStatusLed({ mode: "off" });
  else {
    if (!color || !(LED_COLORS as readonly string[]).includes(color)) throw new Error(`'${color}' is not a status LED colour`);
    await held().setStatusLed({ mode, color });
  }
  statusLed = mode === "off" || !color ? null : { mode, color };
  tell();
  log("sent", mode === "off" ? "Status LED off" : `Status LED ${color}${mode === "flash" ? " flashing" : ""}`);
}

export async function setExternalLed(color: ExternalLedColor | "off"): Promise<void> {
  await held().setExternalLed(color);
  externalLed = color;
  tell();
  log("sent", `LED strips ${color}`);
}

export async function beep(): Promise<void> {
  await held().beep();
  log("sent", "Beep");
}

/** Set the flood by level (0 off, up to the driver's level count); the driver reads it back. */
export async function setFloodLevel(level: number): Promise<void> {
  const value = floodLevelValue(Math.round(level));
  await held().setFloodBrightness(value);
  flood = value;
  tell();
  log("sent", value === 0 ? "Flood off" : `Flood brightness ${value}`);
}

export async function identity(): Promise<{ firmware: string; build: string; engine: string }> {
  const open = held();
  const info = await open.systemInfo();
  const engine = await open.engineRevision();
  const build = `${info.buildDate} ${info.buildTime}`.trim();
  log("info", `Firmware ${info.firmware} · built ${build} · engine ${engine}`);
  return { firmware: info.firmware, build, engine };
}

/** Move a simulated document on the glass. The page offers this only when mocking. */
export function simulate(action: "place" | "passport" | "boarding-pass" | "flip" | "remove"): void {
  if (!mock || !mockPenta) throw new Error("Only a mock scanner has a simulated document");
  if (action === "passport") {
    // Placed like any document, so the driver reports it; the data page is the mock's alone.
    passport = specimenPassport();
    log("info", "Mock passport placed (specimen data)");
    mockPenta.place(false);
    tell();
    return;
  }
  if (action === "place") mockPenta.place(false);
  else if (action === "boarding-pass") mockPenta.place(true);
  else if (action === "flip") mockPenta.flip();
  else mockPenta.remove();
}

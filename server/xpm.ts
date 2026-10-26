/**
 * The Hengstler XPM (the lab's TPM-200HR), as one device of the tester: the 919's boarding-pass printer.
 *
 * What hardware-libs' driver reaches, and so what this tests: the status word (paper out, paper low,
 * a pass waiting in the chute, the head raised, jams and their context), the printhead temperature and
 * supply voltage, the identity block, and raster printing with a cut. The printer never volunteers
 * status, so an open session asks for it every couple of seconds.
 *
 * Print density, print speed and form length are left out on purpose: the printer may keep them after
 * the host lets go, and a technician's test would then change every boarding pass the kiosk prints.
 *
 * The test print is a fixed, fabricated sample marked NOT A BOARDING PASS: no passenger or booking.
 *
 * @module
 */

import type { Transport } from "@eai/models";
import { openXPM, PID, VID, XPM } from "@eai/xpm";
import type { XPMPrinterInfo, XPMStatus, XPMStatusFlags } from "@eai/xpm";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("xpm", kind, text);

// ---------------------------------------------------------------------------------------------
// The test pass: a 5x7 font rendered into the 1-bit rows the driver prints.
// ---------------------------------------------------------------------------------------------

/** Each glyph is seven rows of five bits, as hex pairs; bit 4 is the leftmost dot. */
const FONT: Record<string, string> = {
  A: "0E11111F111111",
  B: "1E11111E11111E",
  C: "0E11101010110E",
  D: "1E11111111111E",
  E: "1F10101E10101F",
  F: "1F10101E101010",
  G: "0E11101711110F",
  H: "1111111F111111",
  I: "0E04040404040E",
  J: "0702020202120C",
  K: "11121418141211",
  L: "1010101010101F",
  M: "111B1515111111",
  N: "11111915131111",
  O: "0E11111111110E",
  P: "1E11111E101010",
  Q: "0E11111115120D",
  R: "1E11111E141211",
  S: "0F10100E01011E",
  T: "1F040404040404",
  U: "1111111111110E",
  V: "11111111110A04",
  W: "1111111515150A",
  X: "11110A040A1111",
  Y: "11110A04040404",
  Z: "1F01020408101F",
  "0": "0E11131519110E",
  "1": "040C040404040E",
  "2": "0E11010204081F",
  "3": "1F02040201110E",
  "4": "02060A121F0202",
  "5": "1F101E0101110E",
  "6": "0608101E11110E",
  "7": "1F010204080808",
  "8": "0E11110E11110E",
  "9": "0E11110F01020C",
  " ": "00000000000000",
  "/": "01010204081010",
  "-": "0000001F000000",
  ":": "000C0C000C0C00",
  "*": "0004150E150400",
};

/** 576 dots is 49 mm at the 200HR's 300 dpi: inside any boarding-pass stock. */
const WIDTH = 576;
const SCALE = 4;
const ADVANCE = 6 * SCALE;
const LINE = 10 * SCALE;
/** Long enough for the printer to feed the page out to the cutter (about 3 inches). */
const MIN_ROWS = 900;

/** The sample, as packed rows (MSB first, set = black). The time tells one test print from the next. */
export function samplePass(now = new Date()): Uint8Array[] {
  const stamp = now.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const text = [
    "*** TEST PRINT ***",
    "NOT A BOARDING PASS",
    "",
    "TEST/SAMPLE PASSENGER",
    "FLIGHT XX 0000",
    "AAA TO ZZZ",
    "SEAT 00X  GATE 00",
    "",
    "",
    "",
    "",
    "PERIPHERAL TESTER",
    stamp,
  ];
  const rows = Array.from({ length: MIN_ROWS }, () => new Uint8Array(WIDTH / 8));
  const dot = (x: number, y: number) => rows[y][x >> 3] |= 0x80 >> (x & 7);
  const block = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) dot(x, y);
  };

  // A frame, so a skewed or clipped print shows at a glance.
  block(0, 0, WIDTH, 4);
  block(0, MIN_ROWS - 4, WIDTH, 4);
  block(0, 0, 4, MIN_ROWS);
  block(WIDTH - 4, 0, 4, MIN_ROWS);

  text.forEach((line, n) => {
    const y0 = 24 + n * LINE;
    [...line].forEach((char, i) => {
      const glyph = FONT[char];
      if (!glyph) throw new Error(`The test pass font has no '${char}'`);
      for (let r = 0; r < 7; r++) {
        const bits = parseInt(glyph.slice(r * 2, r * 2 + 2), 16);
        for (let c = 0; c < 5; c++) if (bits & (0x10 >> c)) block(16 + i * ADVANCE + c * SCALE, y0 + r * SCALE, SCALE, SCALE);
      }
    });
  });

  // Bars where a real pass carries its barcode. Not a symbology: nothing scans from it.
  for (let x = 16, i = 0; x < WIDTH - 32; i++) {
    const w = ((i * 7) % 3 + 1) * SCALE;
    if (i % 2 === 0) block(x, 24 + 8 * LINE, w, 3 * LINE);
    x += w;
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// A fake printer, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

const STATUS_REQUEST = [0x1d, 0x61, 0x00, 0x01];
const INFO_REQUEST = [0x1d, 0x61, 0x00, 0x02];
/** How long the fake takes to print and cut a pass. */
const MOCK_PRINT_MS = 800;
/** "Paper jammed" (low byte 1) "while printing" (high byte 1). */
const MOCK_JAM = 0x0101;

export type Simulation = "paper-ok" | "paper-low" | "paper-out" | "jam" | "clear-jam" | "take";
const SIMULATIONS: readonly Simulation[] = ["paper-ok", "paper-low", "paper-out", "jam", "clear-jam", "take"];

const endsWith = (data: Uint8Array, tail: number[]) =>
  data.length >= tail.length && tail.every((byte, i) => data[data.length - tail.length + i] === byte);

/**
 * Speaks enough of the XPM's USB protocol for the real driver: the 18-byte status reply to `GS a 00 01`,
 * the 121-byte identity reply to `GS a 00 02`, and a print batch, whose trailing status request is
 * answered only once the fake has "printed", as the printer does.
 */
class MockXpm implements Transport {
  isOpen = true;
  paper: "ok" | "low" | "out" = "ok";
  jammed = false;
  chute = false;
  #replies: { data: Uint8Array; at: number }[] = [];

  write(data: Uint8Array): Promise<void> {
    if (!this.isOpen) return Promise.reject(new Error("not open"));
    if (data.length === 4 && endsWith(data, INFO_REQUEST)) this.#replies.push({ data: this.#info(), at: 0 });
    else if (endsWith(data, STATUS_REQUEST)) {
      // A batch longer than the request alone is a print. Out of paper or jammed, nothing feeds.
      const prints = data.length > 4 && this.paper !== "out" && !this.jammed;
      if (prints) this.chute = true;
      this.#replies.push({ data: this.#status(), at: prints ? performance.now() + MOCK_PRINT_MS : 0 });
    }
    return Promise.resolve();
  }

  read(_maxLength: number): Promise<Uint8Array | null> {
    if (!this.isOpen) return Promise.reject(new Error("not open"));
    const next = this.#replies[0];
    if (next && performance.now() >= next.at) return Promise.resolve(this.#replies.shift()!.data);
    // Like a USB read with nothing to deliver: null after a short timeout.
    return new Promise((resolve) => setTimeout(() => resolve(null), 20));
  }

  readUntil(): Promise<Uint8Array | null> {
    return Promise.reject(new Error("the XPM sizes its own reads"));
  }

  close(): Promise<void> {
    this.isOpen = false;
    return Promise.resolve();
  }

  #status(): Uint8Array {
    const out = new Uint8Array(18);
    out.set([0x1b, 0xff, 0x02, 14]);
    const view = new DataView(out.buffer, 4);
    const flags = (this.paper === "out" ? 0x10 : 0) | (this.paper === "low" ? 0x20 : 0) | (this.chute ? 0x80 : 0) |
      (this.jammed ? 0x01 : 0);
    view.setUint32(0, flags, true);
    view.setInt16(5, 31, true); // printhead, degrees C
    view.setUint16(7, 240, true); // 24.0 V
    view.setUint16(10, this.jammed ? MOCK_JAM : 0, true);
    return out;
  }

  #info(): Uint8Array {
    const out = new Uint8Array(121);
    out.set([0x1b, 0xff, 0x03, 117]);
    const payload = out.subarray(4);
    const ascii = (offset: number, text: string) => payload.set(new TextEncoder().encode(text), offset);
    payload[0] = 1;
    ascii(1, "TPM-200HR-MOCK");
    ascii(18, "MOCK0001");
    ascii(35, "2026-01-01");
    new DataView(payload.buffer, payload.byteOffset).setUint32(52, 0x0002_0000, true); // XPM-200HR
    ascii(68, "FW-MOCK");
    ascii(85, "1.00");
    ascii(96, "2026-01-01");
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export type Status = "closed" | "opening" | "open";

/** The printer never sends status unasked; this is how stale the page's view may get. */
const POLL_MS = 2000;

let xpm: XPM | null = null;
let mockXpm: MockXpm | null = null;
let status: Status = "closed";
let mock = false;
let printing = false;
let printer: {
  paper: "ok" | "low" | "out";
  /** The driver's flag names that are set, in its order. */
  flags: (keyof XPMStatusFlags)[];
  /** The driver's decoding of the error code, or null when there is none. */
  error: { type: string; context: string } | null;
  temperature: number;
  voltage: number;
} | null = null;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let polling: Promise<void> | null = null;
let pollError: string | null = null;

const usbId = [VID, PID].map((id) => id.toString(16).padStart(4, "0")).join(":");

export const state = () => ({
  status,
  mock,
  usbId,
  printing,
  printer,
  /** What the fake is set to, so the mock card can show it. Null on real hardware. */
  simulated: mockXpm ? { paper: mockXpm.paper, jammed: mockXpm.jammed, chute: mockXpm.chute } : null,
});

const tell = () => announce("xpm", state());

export function configure(options: { mock: boolean }): void {
  // A device opened in one mode must never carry on into the other.
  if (status !== "closed") throw new Error("Disconnect before changing mode");
  mock = options.mock;
  tell();
}

/** What an operator should hear about, worded once for the log and the print refusal. */
function trouble(next: NonNullable<typeof printer>): string | null {
  if (next.error) return `${next.error.type} (${next.error.context.toLowerCase()})`;
  if (next.paper === "out") return "Paper out";
  if (next.flags.includes("printheadRaised")) return "Printhead raised";
  return null;
}

function reflect(read: XPMStatus): void {
  const flags = (Object.keys(read.flags) as (keyof XPMStatusFlags)[]).filter((name) => read.flags[name]);
  const next = {
    paper: read.flags.paperOut || read.flags.printUnitEmpty
      ? "out" as const
      : read.flags.paperLowA || read.flags.paperLowB
      ? "low" as const
      : "ok" as const,
    flags,
    error: read.decodedError.hasError ? { type: read.decodedError.errorType, context: read.decodedError.errorContext } : null,
    temperature: read.printheadTemp,
    voltage: read.controlBoardVoltage,
  };
  // Log transitions only: the poll would otherwise repeat the same line every two seconds.
  const was = printer;
  if (was && trouble(next) !== trouble(was)) log(trouble(next) ? "warned" : "ok", trouble(next) ?? "Printer ready");
  if (was && next.paper === "low" && was.paper !== "low") log("warned", "Paper low");
  if (was && next.flags.includes("paperInChute") !== was.flags.includes("paperInChute")) {
    log("info", next.flags.includes("paperInChute") ? "A pass is waiting in the chute" : "The chute is clear");
  }
  printer = next;
  tell();
}

function wire(opened: XPM): void {
  opened.on("status", (read: XPMStatus) => {
    if (xpm === opened) reflect(read);
  });
  opened.on("error", (err: Error) => log("error", err.message));
  opened.on("disconnect", () => {
    if (xpm !== opened) return;
    release();
    log("error", "The printer went away. Reconnect to continue.");
    opened.close().catch(() => {});
  });
}

function schedulePoll(opened: XPM): void {
  pollTimer = setTimeout(() => {
    polling = refresh(opened).finally(() => {
      polling = null;
      if (xpm === opened) schedulePoll(opened);
    });
  }, POLL_MS);
}

/** Ask for status; the "status" event updates the page. A failed poll is logged once, not every time. */
async function refresh(opened: XPM): Promise<void> {
  try {
    await opened.getStatus();
    pollError = null;
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (xpm === opened && message !== pollError) log("warned", `Status poll: ${message}`);
    pollError = message;
  }
}

/** Forget the handle and everything read through it. The caller closes it. */
function release(): void {
  xpm = null;
  mockXpm = null;
  clearTimeout(pollTimer);
  status = "closed";
  printing = false;
  printer = null;
  pollError = null;
  tell();
}

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();
  log("info", mock ? "Opening mock XPM" : `Opening ${usbId} over USB`);
  try {
    if (mock) {
      mockXpm = new MockXpm();
      xpm = new XPM(mockXpm);
      // What openXPM does after opening its USB transport.
      await xpm.drain();
    }
    else {
      xpm = await openXPM();
    }
    wire(xpm);
    await xpm.getStatus();
  }
  catch (err) {
    await xpm?.close().catch(() => {});
    xpm = null;
    mockXpm = null;
    status = "closed";
    printer = null;
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  status = "open";
  tell();
  schedulePoll(xpm);
  log("ok", "Printer answered status");
}

export async function disconnect(): Promise<void> {
  const open = xpm;
  if (!open) return;
  release();
  // A poll already asking finishes first, so its read is not cut off by the close.
  await polling;
  await open.close();
  log("info", "Printer released");
}

function held(): XPM {
  if (!xpm) throw new Error("Not connected");
  return xpm;
}

export const actions: Record<string, (body: Record<string, unknown>) => unknown> = {
  /** Print and cut the fabricated sample. Resolves when the printer reports the job finished. */
  "print-test": async () => {
    const open = held();
    if (printing) throw new Error("A test print is already running");
    printing = true;
    tell();
    log("sent", "Test pass sent");
    try {
      // The driver answers with the post-print status, which has already reached the page by its event.
      const after = await open.printScanlines(samplePass());
      if (xpm !== open) return;
      const problem = printer && trouble(printer);
      if (problem) throw new Error(`The printer reported: ${problem}`);
      log("ok", `Test pass printed and cut${after.flags.paperInChute ? "; it is waiting in the chute" : ""}`);
    }
    catch (err) {
      log("error", `Test print: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    finally {
      if (xpm === open) {
        printing = false;
        tell();
      }
    }
  },

  identity: async (): Promise<Pick<XPMPrinterInfo, "model" | "partNumber" | "serialNumber" | "firmwareVersion" | "firmwareDate">> => {
    const info = await held().getPrinterInfo();
    log("info", `${info.model} · serial ${info.serialNumber} · firmware ${info.firmwareVersion}`);
    const { model, partNumber, serialNumber, firmwareVersion, firmwareDate } = info;
    return { model, partNumber, serialNumber, firmwareVersion, firmwareDate };
  },

  /** Change what the fake printer reports. The page offers this only when mocking. */
  simulate: async (body) => {
    const action = body.action as Simulation;
    if (!SIMULATIONS.includes(action)) throw new Error(`unknown simulation '${body.action}'`);
    if (!mock || !mockXpm) throw new Error("Only a mock printer has simulated paper");
    if (action === "paper-ok") mockXpm.paper = "ok";
    else if (action === "paper-low") mockXpm.paper = "low";
    else if (action === "paper-out") mockXpm.paper = "out";
    else if (action === "jam") mockXpm.jammed = true;
    else if (action === "clear-jam") mockXpm.jammed = false;
    else mockXpm.chute = false;
    tell();
    // Read it back now rather than at the next poll, so the page answers the click.
    await held().getStatus();
  },
};

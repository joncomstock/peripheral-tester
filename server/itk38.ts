/**
 * The Practical Automation ITK 38, as one device of the tester: the SITA D4's boarding-pass printer.
 *
 * What hardware-libs' driver reaches, and so what this tests: the Complete Status the printer streams
 * (its sixteen flags, error code, document count, head temperature, form length and firmware), the
 * serial number, printing a raster image, and re-presenting or disposing a printed document. The driver
 * knows no bag-tag stock, so the only test print is a boarding pass. Flash programming is left out on
 * purpose: it rewrites the firmware, and the driver does not offer it anyway.
 *
 * Nothing printed here carries a passenger: the sample is fixed and marked not valid for travel.
 *
 * @module
 */

import type { Transport } from "@eai/models";
import { ITK38, PID, VID } from "@eai/itk38";
import { USBTransport } from "@eai/usb";
import type { ITK38BitFlags, ITK38Status } from "@eai/itk38";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("itk38", kind, text);

// ---------------------------------------------------------------------------------------------
// The test print: a boarding pass drawn in a 5x7 font, straight into the driver's scanlines.
// ---------------------------------------------------------------------------------------------

const WIDTH = 2400; // dots across the head; 300 bytes per scanline
const HEIGHT = 975; // 3.25 in at 300 dpi, the ATB boarding-pass length

/** 5x7 glyphs, one hex byte per row, bit 4 the leftmost column. Only what the sample spells. */
const FONT: Record<string, string> = {
  A: "0e11111f111111",
  B: "1e11111e11111e",
  C: "0e11101010110e",
  D: "1e11111111111e",
  E: "1f10101e10101f",
  F: "1f10101e101010",
  G: "0e11101711110f",
  H: "1111111f111111",
  I: "0e04040404040e",
  J: "0702020202120c",
  K: "11121418141211",
  L: "1010101010101f",
  M: "111b1515111111",
  N: "11111915131111",
  O: "0e11111111110e",
  P: "1e11111e101010",
  Q: "0e11111115120d",
  R: "1e11111e141211",
  S: "0f10100e01011e",
  T: "1f040404040404",
  U: "1111111111110e",
  V: "11111111110a04",
  W: "1111111515150a",
  X: "11110a040a1111",
  Y: "1111110a040404",
  Z: "1f01020408101f",
  "0": "0e11131519110e",
  "1": "040c040404040e",
  "2": "0e11010204081f",
  "3": "1f02040201110e",
  "4": "02060a121f0202",
  "5": "1f101e0101110e",
  "6": "0608101e11110e",
  "7": "1f010204080808",
  "8": "0e11110e11110e",
  "9": "0e11110f01020c",
  "-": "0000001f000000",
  "/": "00010204081000",
  ".": "00000000000c0c",
  ":": "000c0c000c0c00",
};

function sampleBoardingPass(): Uint8Array[] {
  const lines = Array.from({ length: HEIGHT }, () => new Uint8Array(WIDTH / 8));
  const dot = (x: number, y: number) => lines[y][x >> 3] |= 0x80 >> (x & 7);
  const box = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) dot(x, y);
  };
  const text = (s: string, x: number, y: number, scale: number) => {
    for (const [i, ch] of [...s].entries()) {
      const rows = FONT[ch] ?? "";
      for (let r = 0; r < rows.length / 2; r++) {
        const bits = parseInt(rows.slice(r * 2, r * 2 + 2), 16);
        for (let c = 0; c < 5; c++) {
          if (bits & (0x10 >> c)) box(x + (i * 6 + c) * scale, y + r * scale, x + (i * 6 + c + 1) * scale, y + (r + 1) * scale);
        }
      }
    }
  };
  // A frame, and a stub divider like a real pass, so alignment on the stock is visible.
  box(30, 30, WIDTH - 30, 42), box(30, HEIGHT - 42, WIDTH - 30, HEIGHT - 30);
  box(30, 30, 42, HEIGHT - 30), box(WIDTH - 42, 30, WIDTH - 30, HEIGHT - 30);
  box(1780, 160, 1788, HEIGHT - 80);
  text("SAMPLE - NOT VALID FOR TRAVEL", 90, 70, 10);
  text("PASSENGER  TEST/PRINTER", 90, 210, 7);
  text("FROM  TESTVILLE", 90, 310, 7);
  text("TO    NOWHERE", 90, 410, 7);
  text("FLIGHT ZZ 0000  SEAT 00A", 90, 510, 7);
  text("BOARDING 00:00  GATE 00", 90, 610, 7);
  text("PERIPHERAL TESTER - ITK 38 PRINT TEST", 90, 800, 5);
  text("STUB", 1840, 210, 7);
  text("ZZ 0000", 1840, 310, 7);
  text("00A", 1840, 410, 7);
  return lines;
}

// ---------------------------------------------------------------------------------------------
// A fake printer, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

const ESC = 0x1b;
const PACKET = 8; // the IN endpoint's packet size; the driver frames a message as packets until a short one
const STATUS_EVERY_MS = 500; // the real printer answers every poll; this keeps the mock's stream cheap
const QUIET_MS = 100; // the USB transport's read timeout

/** The flags the mock can hold, by bit: byte 1 is MSB-first error conditions, byte 2 operational state. */
const BIT: Partial<Record<keyof ITK38BitFlags, [number, number]>> = {
  headLeverUp: [0, 0x02],
  paperError: [0, 0x08],
  outOfPaper: [0, 0x01],
  documentNotTaken: [1, 0x08],
  documentDisposed: [1, 0x02],
  lowPaper: [1, 0x01],
};

export type Simulation = "paper-ok" | "paper-low" | "paper-out" | "jam" | "lever-up" | "lever-down" | "take" | "unplug";
const SIMULATIONS: readonly Simulation[] = ["paper-ok", "paper-low", "paper-out", "jam", "lever-up", "lever-down", "take", "unplug"];

/**
 * Speaks the ITK 38's USB protocol as the driver's reader loop sees it: every quiet poll is answered
 * with a Complete Status in 8-byte packets, `ESC I A 09` with the serial number, and the
 * end-of-page command as a printed document. Every message here ends on a short packet, which is how
 * the driver tells messages apart.
 */
/**
 * For tests: `silent` makes the next mock a wedged printer that never streams status, so connect times
 * out; `transport` is the newest mock's, so a test can see it was closed.
 */
export const mockFaults = { silent: false, transport: null as Transport | null };

class MockItk38 {
  flags = new Set<keyof ITK38BitFlags>();
  #documents = 0;
  #queue: Uint8Array[] = [];
  #lastStatus = 0;
  #open = true;
  #unplugged = false;
  #wake: (() => void) | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #enc = new TextEncoder();

  readonly transport: Transport = {
    isOpen: true,
    write: (data: Uint8Array) => this.#command(data),
    read: () => this.#read(),
    readUntil: () => Promise.reject(new Error("the ITK 38 frames its own reads")),
    close: () => this.#close(),
  } as unknown as Transport;

  constructor() {
    mockFaults.transport = this.transport;
  }

  simulate(event: Simulation): void {
    const set = (flag: keyof ITK38BitFlags, on: boolean) => on ? this.flags.add(flag) : this.flags.delete(flag);
    if (event.startsWith("paper-") || event === "jam") {
      set("lowPaper", event === "paper-low");
      set("outOfPaper", event === "paper-out");
      set("paperError", event === "jam");
    }
    else if (event === "lever-up" || event === "lever-down") set("headLeverUp", event === "lever-up");
    else if (event === "take") set("documentNotTaken", false);
    else this.#unplugged = true;
  }

  #enqueue(message: Uint8Array): void {
    for (let i = 0; i < message.length; i += PACKET) this.#queue.push(message.slice(i, i + PACKET));
  }

  #status(): Uint8Array {
    const bits = [0, 0];
    for (const flag of this.flags) {
      const [byte, mask] = BIT[flag]!;
      bits[byte] |= mask;
    }
    const fw = "V3.05S.MOCK";
    const head = this.#enc.encode("C00");
    const tail = this.#enc.encode("01000" + `02${String(this.#documents).padStart(8, "0")}` + "0325C04");
    const end = this.#enc.encode(`05${String(fw.length).padStart(2, "0")}${fw}`);
    // Form length 325 (3.25 in, in 0.01 in units) is binary, little-endian.
    return new Uint8Array([...head, ...bits, ...tail, 325 & 0xff, 325 >> 8, ...end]);
  }

  #command(data: Uint8Array): Promise<void> {
    if (data[0] === ESC && data[1] === 0x49 && data[2] === 0x41 && data[3] === 0x09) {
      this.#enqueue(this.#enc.encode("A09MOCK0000ITK38001"));
    }
    else if (data[0] === ESC && data[1] === 0x54 && data[2] === 0x44) {
      this.flags.delete("documentNotTaken");
      this.flags.add("documentDisposed");
    }
    else if (data.length === 4 && data[0] === 0 && data[1] === 0 && data[2] === ESC && data[3] === 0x65) {
      // End of page. A printer with no paper, a jam or the head open prints nothing.
      if (!["outOfPaper", "paperError", "headLeverUp"].some((f) => this.flags.has(f as keyof ITK38BitFlags))) {
        this.#documents++;
        this.flags.add("documentNotTaken");
        this.flags.delete("documentDisposed");
      }
    }
    // ESC T E (re-present) leaves the document where it is; the job's other commands need no answer.
    this.#wake?.();
    return Promise.resolve();
  }

  async #read(): Promise<Uint8Array | null> {
    // Unplugged, the USB transport closes itself on the failed transfer, and every read after says so.
    if (!this.#open || this.#unplugged) throw new Error("USB device is not open");
    const next = this.#queue.shift();
    if (next) return next;
    await new Promise<void>((resolve) => {
      this.#wake = resolve;
      this.#timer = setTimeout(resolve, QUIET_MS);
    });
    clearTimeout(this.#timer);
    this.#wake = null;
    if (!mockFaults.silent && this.#queue.length === 0 && Date.now() - this.#lastStatus >= STATUS_EVERY_MS) {
      this.#lastStatus = Date.now();
      this.#enqueue(this.#status());
    }
    return this.#queue.shift() ?? null;
  }

  #close(): Promise<void> {
    this.#open = false;
    (this.transport as { isOpen: boolean }).isOpen = false;
    this.#wake?.();
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

/** Flags that mean the printer cannot print, or soon will not: logged as warnings when raised. */
const PROBLEMS = new Set<string>([
  "systemNotReady",
  "diagnosticError",
  "manuallyDeselected",
  "transportError",
  "paperError",
  "cutterError",
  "headLeverUp",
  "outOfPaper",
  "lowPaper",
]);

let printer: ITK38 | null = null;
let mockPrinter: MockItk38 | null = null;
let status: "closed" | "opening" | "open" = "closed";
let mock = false;
let printerStatus: ITK38Status | null = null;

const usbId = [VID, PID].map((id) => id.toString(16).padStart(4, "0")).join(":");

export const state = () => ({
  status,
  mock,
  usbId,
  /** The last Complete Status as the driver parsed it, or null until the first one. */
  printer: printerStatus,
  simulations: SIMULATIONS,
});

const tell = () => announce("itk38", state());

export function configure(options: { mock: boolean }): void {
  if (status !== "closed") throw new Error("Disconnect before changing mode");
  mock = options.mock;
  tell();
}

/** The printer is gone: forget it, say so once, and stop the driver's reader. */
function lost(opened: ITK38): void {
  if (printer !== opened) return;
  printer = null;
  mockPrinter = null;
  printerStatus = null;
  status = "closed";
  log("error", "The printer went away. Reconnect to continue.");
  tell();
  // Not awaited: this may run inside the reader loop, which close() waits for.
  opened.close().catch(() => {});
}

function wire(opened: ITK38): void {
  // The printer reports constantly; only a change is worth a broadcast.
  opened.on("status", (next: ITK38Status) => {
    if (printer !== opened || JSON.stringify(next) === JSON.stringify(printerStatus)) return;
    printerStatus = next;
    tell();
  });
  opened.on("flags_changed", (changed: Partial<ITK38BitFlags>) => {
    if (printer !== opened) return;
    for (const [flag, on] of Object.entries(changed)) {
      log(on && PROBLEMS.has(flag) ? "warned" : "info", `${flag} ${on ? "raised" : "cleared"}`);
    }
  });
  opened.on("error", (err: Error) => {
    // After an unplug the transport has closed itself and the driver retries the read without pause;
    // its "not open" is a disconnect the driver does not recognise.
    if (err.message.includes("not open")) lost(opened);
    else if (printer === opened) log("error", err.message);
  });
  opened.on("disconnect", () => lost(opened));
}

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();
  log("info", mock ? "Opening mock ITK 38" : `Opening ${usbId} over USB`);
  try {
    if (mock) {
      mockPrinter = new MockItk38();
      printer = new ITK38(mockPrinter.transport);
    }
    else {
      // What openITK38 does, but holding the printer before the first status: if that times out,
      // the catch below closes the transport rather than leaving its reader running.
      const transport = new USBTransport(VID, PID);
      await transport.open();
      printer = new ITK38(transport);
    }
    // The first status means the printer is listening.
    printerStatus = await printer.getStatus();
    wire(printer);
  }
  catch (err) {
    await printer?.close().catch(() => {});
    printer = null;
    mockPrinter = null;
    printerStatus = null;
    status = "closed";
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  status = "open";
  tell();
  log("ok", `Printer answered — firmware ${printerStatus.firmwareVersion}`);
}

export async function disconnect(): Promise<void> {
  const open = printer;
  if (!open) return;
  printer = null;
  status = "closed";
  // Nothing to darken: the printer has no lights or motion of its own to leave running.
  await open.close();
  mockPrinter = null;
  printerStatus = null;
  tell();
  log("info", "Printer released");
}

function held(): ITK38 {
  if (!printer) throw new Error("Not connected");
  return printer;
}

export const actions: Record<string, (body: Record<string, unknown>) => unknown> = {
  /** Print the fixed sample. Refused while the printer says it cannot print, so no job waits to surprise anyone. */
  print: async () => {
    const open = held();
    const blocking = Object.entries(printerStatus?.flags ?? {})
      .filter(([flag, on]) => on && PROBLEMS.has(flag) && flag !== "lowPaper")
      .map(([flag]) => flag);
    if (blocking.length) throw new Error(`The printer reports ${blocking.join(", ")}`);
    await open.printScanlines(sampleBoardingPass());
    log("sent", `Test boarding pass sent (${HEIGHT} lines, 8 x 3.25 in)`);
  },
  eject: async () => {
    await held().eject();
    log("sent", "Re-present document");
  },
  dispose: async () => {
    await held().dispose();
    log("sent", "Dispose document");
  },
  identity: async () => {
    const open = held();
    const serial = await open.getSerialNumber();
    const firmware = printerStatus?.firmwareVersion ?? "";
    log("info", `Serial ${serial} · firmware ${firmware}`);
    return { serial, firmware };
  },
  simulate: (body) => {
    if (!mock || !mockPrinter) throw new Error("Only a mock printer has simulated paper");
    const event = body.event;
    if (typeof event !== "string" || !(SIMULATIONS as readonly string[]).includes(event)) {
      throw new Error(`event must be one of ${SIMULATIONS.join(", ")}`);
    }
    mockPrinter.simulate(event as Simulation);
    log("info", `Simulated ${event}`);
  },
};

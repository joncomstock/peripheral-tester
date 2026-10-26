/**
 * The Datalogic Gryphon GFS4470 fixed-mount 2D scanner, as one device of the tester.
 *
 * What hardware-libs' driver reaches over the scanner's USB-COM port: presentation reading (the
 * scanner reads whatever is shown to it), a single triggered read with a time-out, which symbologies
 * it decodes, which presentation mode it reads in, and its firmware release. Saving the
 * configuration to flash and restarting the scanner are left out on purpose: both take it off USB,
 * and a save outlives the test.
 *
 * Nothing is saved, but some settings last in the scanner's RAM until it is power-cycled: the
 * driver's setup (decodes end in ETX, STX/ETX start and stop a read, Serial On Line mode, so it
 * reads only when asked) and a trigger's Scanning Active Time and Phase Off. Symbologies changed
 * here are put back to all-enabled on disconnect.
 *
 * The driver reports no unplug. A presentation read loop ends on its own only when the port stops
 * answering, and a command fails to write or gets no reply once it is gone; either closes the session.
 *
 * A barcode is often a boarding pass, which carries a passenger's name and booking. The log is told
 * one was read, never its text; the text goes to the page in state. The driver hands over the text
 * alone, so the symbology is known only when the scanner sends an AIM identifier ahead of it.
 *
 * @module
 */

import type { Transport } from "@eai/models";
import { connectDatalogic, DATALOGIC_VENDOR_ID, DatalogicScanner, GFS4470_PRODUCT_ID, OperatingMode } from "@eai/datalogic";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("datalogic", kind, text);

/** The names `setSymbologies` takes. The driver checks them but does not export the list. */
const SYMBOLOGIES = ["PDF417", "QR", "AZTEC", "DATAMATRIX", "CODE39", "CODE128", "CODE2OF5"];
/** The two Operating Modes `monitor()` can read in. */
const PRESENTATION_MODES = ["OBJECT_SENSE", "AUTOMATIC"] as const;
type PresentationMode = typeof PRESENTATION_MODES[number];

// ---------------------------------------------------------------------------------------------
// A fake scanner, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

/** Fabricated codes, each behind its AIM identifier: no real passenger or booking. */
const DEMO_CODES = {
  "boarding-pass": { label: "Boarding pass", enable: "P4EN", text: "]L2M1SAMPLE/TEST      EZZZ999 YYZYVRAC 0000 299Y012A0042 100" },
  qr: { label: "QR code", enable: "QREN", text: "]Q1https://example.com/not-a-real-ticket" },
} as const;
export type DatalogicSimulation = keyof typeof DEMO_CODES;
const SIMULATIONS = [...Object.entries(DEMO_CODES).map(([code, { label }]) => ({ code, label })), { code: "unplug", label: "Unplug" }];

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * A GFS4470 on the other end of the serial port, answering the way the driver's own test fake does:
 * `$>` for an accepted command, the stored value for a read, the bare release for `$+$!`. A decode
 * goes out only while the scanner would be reading: in a presentation mode, or inside a Serial
 * On Line phase opened by STX.
 */
class MockScanner implements Transport {
  isOpen = true;
  /** The scanner's RAM, which outlives a session as the real one does until it is power-cycled. */
  static #ram = new Map<string, string>([["SNRM", OperatingMode.OBJECT_SENSE], ["SNET", "05"]]);
  #settings = MockScanner.#ram;
  /** When the phase opened by STX ends; 0 when none is open. */
  #phaseUntil = 0;
  #buffer: number[] = [];
  #wake: (() => void)[] = [];

  /** The cable is pulled: reads end, and writes fail as the serial transport's do. */
  unplug(): void {
    this.isOpen = false;
    for (const resolve of this.#wake.splice(0)) resolve();
  }

  /** Present a code to the scanner. A symbology it was told not to decode, it ignores. */
  show(code: string, enable: string): void {
    const mode = this.#settings.get("SNRM");
    const presenting = mode === OperatingMode.OBJECT_SENSE || mode === OperatingMode.AUTOMATIC;
    if (!presenting && Date.now() > this.#phaseUntil) throw new Error("The scanner is not reading: Listen or Trigger first");
    if (this.#settings.get(enable) === "00") return;
    this.#phaseUntil = 0; // a decode ends a single read's phase
    this.#feed(`${code}\x03`);
  }

  #feed(text: string): void {
    this.#buffer.push(...enc.encode(text));
    for (const resolve of this.#wake.splice(0)) resolve();
  }

  write(data: Uint8Array): void {
    if (!this.isOpen) throw new Error("cannot write to the mock port: the port is not open");
    if (data[0] === 0x02) {
      this.#phaseUntil = Date.now() + parseInt(this.#settings.get("SNET") ?? "05", 16) * 1000;
      return;
    }
    if (data[0] === 0x03) {
      this.#phaseUntil = 0;
      return;
    }
    const cmd = dec.decode(data).replace(/^\$/, "").replace(/\r$/, "");
    if (cmd === "+$!") return this.#feed("Gryphon-GFS4470 SOFTWARE RELEASE 610088906 BUILD MOCK\r");
    if (cmd.startsWith("c")) {
      const value = this.#settings.get(cmd.slice(1));
      return this.#feed(value === undefined ? "$%\r" : `$>${value}\r`);
    }
    if (cmd === "AD") { for (const { enable } of Object.values(DEMO_CODES)) this.#settings.set(enable, "00"); }
    if (cmd.startsWith("C")) this.#settings.set(cmd.slice(1, 5), cmd.slice(5));
    this.#feed("$>\r");
  }

  read(): Promise<Uint8Array | null> {
    return Promise.resolve(null);
  }

  async readUntil(delimiter: Uint8Array, timeout = 1000, signal?: AbortSignal): Promise<Uint8Array | null> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const at = this.#buffer.indexOf(delimiter[0]);
      if (at !== -1) return new Uint8Array(this.#buffer.splice(0, at + 1).slice(0, at));
      const remaining = deadline - Date.now();
      if (!this.isOpen || signal?.aborted || remaining <= 0) return null;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(remaining, 2 ** 31 - 1));
        signal?.addEventListener("abort", done, { once: true });
        this.#wake.push(done);
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        }
      });
    }
  }

  close(): Promise<void> {
    this.isOpen = false;
    for (const resolve of this.#wake.splice(0)) resolve();
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export type Status = "closed" | "opening" | "open";

let scanner: DatalogicScanner | null = null;
let mockScanner: MockScanner | null = null;
let status: Status = "closed";
let mock = false;
let reading: "presentation" | "single" | null = null;
let barcode: { symbology: string | null; text: string } | null = null;
/** What was last commanded; null until set since connecting. */
let enabled: string[] | null = null;
let presentationMode: PresentationMode = "OBJECT_SENSE";
/** Set while listen or trigger configures the scanner, before the driver's read task exists. */
let starting = false;
/** Polls a presentation read, whose loop ending on its own means the port went away. */
let watch: ReturnType<typeof setInterval> | undefined;

const usbId = [DATALOGIC_VENDOR_ID, GFS4470_PRODUCT_ID].map((id) => id.toString(16).padStart(4, "0")).join(":");

export const state = () => ({
  status,
  mock,
  usbId,
  reading,
  barcode,
  enabled,
  presentationMode,
  /** The driver's vocabularies, so the page keeps no copy. */
  symbologies: SYMBOLOGIES,
  presentationModes: PRESENTATION_MODES,
  simulations: SIMULATIONS,
});

const tell = () => announce("datalogic", state());

export function configure(options: { mock: boolean }): void {
  // A device opened in one mode must never carry on into the other.
  if (status !== "closed") throw new Error("Disconnect before changing mode");
  mock = options.mock;
  tell();
}

function wire(opened: DatalogicScanner): void {
  opened.on("data", (frame: string) => {
    // An AIM identifier is `]`, a letter, a modifier character.
    const aim = /^\][A-Za-z]./.exec(frame)?.[0] ?? null;
    barcode = { symbology: aim, text: aim ? frame.slice(3) : frame };
    if (reading === "single") reading = null;
    // The symbology and length, never the text: a boarding pass carries a passenger's name.
    log("ok", `Barcode read — ${aim ?? "no symbology"}, ${barcode.text.length} characters`);
    tell();
  });
}

/** Forget the scanner. The handle is closed without writing: whatever is left of it is gone. */
function lost(open: DatalogicScanner): void {
  if (scanner !== open) return;
  clearInterval(watch);
  scanner = null;
  mockScanner = null;
  status = "closed";
  reading = null;
  enabled = null;
  open.close().catch(() => {});
  log("error", "The scanner's port stopped answering. Reconnect to continue.");
  tell();
}

/** Run a command; one that could not be written or got no reply means the port is gone. */
async function command<T>(open: DatalogicScanner, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  }
  catch (err) {
    // The driver's own refusals: the scanner answered, so it is still there.
    if (!/rejected|no usable|already in progress/.test(err instanceof Error ? err.message : String(err))) lost(open);
    throw err;
  }
}

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();
  log("info", mock ? "Opening mock Gryphon" : `Opening ${usbId} over its USB serial port`);
  let opened: DatalogicScanner | null = null;
  try {
    if (mock) {
      mockScanner = new MockScanner();
      opened = new DatalogicScanner(mockScanner);
      await opened.setup();
    }
    else {
      opened = await connectDatalogic();
    }
  }
  catch (err) {
    await opened?.close().catch(() => {});
    await mockScanner?.close();
    mockScanner = null;
    status = "closed";
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  scanner = opened;
  opened.presentationMode = OperatingMode[presentationMode];
  wire(opened);
  status = "open";
  tell();
  log("ok", "Scanner answered; idle until Listen or Trigger");
}

export async function disconnect(): Promise<void> {
  const open = scanner;
  if (!open) return;
  clearInterval(watch);
  scanner = null;
  status = "closed";
  // Out of presentation mode, so the scanner does not go on decoding with no one listening.
  await open.deactivate();
  // The next user would otherwise inherit this session's symbologies until a power-cycle.
  if (enabled !== null) await open.resetSymbologies().catch(() => log("warned", "Could not restore every symbology"));
  await open.close();
  mockScanner = null;
  reading = null;
  barcode = null;
  enabled = null;
  tell();
  log("info", "Scanner released");
}

function held(): DatalogicScanner {
  if (!scanner) throw new Error("Not connected");
  return scanner;
}

/** A command sent while a read loop runs would lose its reply to that loop. */
function idle(): DatalogicScanner {
  const open = held();
  if (starting || open.hasActiveReadTask()) throw new Error("Stop reading first");
  return open;
}

export const actions: Record<string, (body: Record<string, unknown>) => unknown> = {
  /** Read every code presented, until `stop`. */
  async listen() {
    const open = idle();
    starting = true;
    try {
      await command(open, () => open.monitor());
    }
    finally {
      starting = false;
    }
    reading = "presentation";
    watch = setInterval(() => {
      if (!open.hasActiveReadTask()) lost(open);
    }, 250);
    tell();
    log("sent", `Listening (${presentationMode.toLowerCase().replace("_", " ")})`);
  },

  async stop() {
    const open = held();
    clearInterval(watch);
    await open.deactivate();
    reading = null;
    tell();
    log("sent", "Stopped reading");
  },

  /** One read, like a trigger pull; answers once it decoded or timed out. Body: `{ seconds?: 1..255 }`. */
  async trigger({ seconds }) {
    if (seconds !== undefined && !(Number.isInteger(seconds) && (seconds as number) >= 1 && (seconds as number) <= 255)) {
      throw new Error("seconds must be a whole number from 1 to 255");
    }
    const open = idle();
    const before = barcode;
    starting = true;
    try {
      await command(open, () => open.activate(seconds === undefined ? undefined : (seconds as number) * 1000));
    }
    finally {
      starting = false;
    }
    reading = "single";
    tell();
    log("sent", seconds === undefined ? "Single read, the scanner's own time-out" : `Single read, ${seconds} s`);
    // Ends at a decode, the time-out, or the port going away (which the next command tells).
    while (open.hasActiveReadTask()) await new Promise((resolve) => setTimeout(resolve, 50));
    if (reading === "single") reading = null;
    const decoded = barcode !== before;
    if (!decoded) log("warned", "Single read ended without a decode");
    tell();
    return { decoded };
  },

  /** Body: `{ codes: string[] }`, an empty list or any of `symbologies`. */
  async symbologies({ codes }) {
    if (!Array.isArray(codes) || codes.some((code) => !SYMBOLOGIES.includes(code))) {
      throw new Error(`codes must be a list drawn from ${SYMBOLOGIES.join(", ")}`);
    }
    const open = idle();
    await command(open, () => open.setSymbologies(codes));
    enabled = SYMBOLOGIES.filter((code) => codes.includes(code));
    tell();
    log("sent", enabled.length ? `Decoding ${enabled.join(", ")}` : "Every symbology disabled");
  },

  /** Body: `{ mode }`, one of `presentationModes`. Takes effect at the next `listen`. */
  presentation({ mode }) {
    if (!PRESENTATION_MODES.includes(mode as PresentationMode)) throw new Error(`mode must be one of ${PRESENTATION_MODES.join(", ")}`);
    idle().presentationMode = OperatingMode[mode as PresentationMode];
    presentationMode = mode as PresentationMode;
    tell();
    log("info", `Presentation mode ${presentationMode.toLowerCase().replace("_", " ")}`);
  },

  async identity() {
    const open = idle();
    const firmware = await command(open, () => open.version());
    log("info", `Firmware ${firmware}`);
    return { firmware };
  },

  /** Body: `{ code }`, one of the demo codes, or `unplug`. Mock only. */
  simulate({ code }) {
    if (!mock || !mockScanner) throw new Error("Only a mock scanner has simulated codes");
    if (code === "unplug") return mockScanner.unplug();
    if (!(typeof code === "string" && Object.hasOwn(DEMO_CODES, code))) {
      throw new Error(`code must be one of ${Object.keys(DEMO_CODES).join(", ")}, unplug`);
    }
    const { text, enable } = DEMO_CODES[code as DatalogicSimulation];
    mockScanner.show(text, enable);
  },
};

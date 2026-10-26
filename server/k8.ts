/**
 * The NCR K8 (2ST) full-page thermal printer, as one device of the tester.
 *
 * What hardware-libs' `K8` reaches, and so what this tests: identity (serial, NCR part number, main
 * firmware), the six status bytes (paper low, paper out, jams, cover, knife), the configuration as
 * read, and a raster page printed and cut. The AEA adapter (`K8Hardware`) is not used: this drives
 * the printer itself, not an AEA host's view of it.
 *
 * Left out on purpose: `setConfig` (an EEPROM write that persists), Printer Recovery 2 (a watchdog
 * reset that drops the unit off USB), and duplex printing. The status is read on demand and after
 * every command, not polled: the printer never reports unprompted.
 *
 * The test page is a fixed pattern of boxes and squares, no text and nothing a customer could own.
 *
 * @module
 */

import { USBTransport } from "@eai/usb";
import { BYTES_PER_ROW, ConnectionLost, faults, K8, MIN_PAGE_ROWS, PID, VID } from "@eai/k8";
import type { K8Status, K8Transport, RasterImage } from "@eai/k8";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("k8", kind, text);

// ---------------------------------------------------------------------------------------------
// A fake printer, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const key = (bytes: Iterable<number>) => [...bytes].join(",");

/** Replies the bench K8 (firmware 00.87) gave, keyed by the query; the serial number is made up. */
const REPLIES: Record<string, Uint8Array> = {
  [key([0x1d, 0x30, 0x04, 0x23])]: Uint8Array.of(0x23, ...ascii("K000MOCK01"), 0x0d),
  [key([0x1d, 0x30, 0x04, 0x27])]: Uint8Array.of(0x27, ...ascii("497-0466327    "), 0x0d),
  [key([0x1d, 0x30, 0x09, 0x01])]: Uint8Array.of(0x4b, 0x4d, 0x08, ...ascii("230110"), ...ascii("00.87"), 0x19, 0x57),
  [key([0x1d, 0x30, 0x0c, 0x00])]: Uint8Array.of(0x01),
  [key([0x1d, 0x30, 0x05, 0x00])]: Uint8Array.of(0x01, 0xc8, 0x03, 0x00, 0xfc, 0x00, 0x01, 0x03, 0x01, 0x00, 0x16, 0x02, 0, 0, 0, 0),
};

/** What the printer goes through after `ESC i`, as status bits: printing, then the knife out and home. */
const PRINTING = { byte0: 0x00, byte2: 0x01 };
const CUT_STARTING = { byte0: 0x40, byte2: 0x02 };
const KNIFE_OUT = { byte0: 0x50, byte2: 0x02 };
const KNIFE_HOME = { byte0: 0x40, byte2: 0x02 };
const PRINT_TIMELINE = [PRINTING, PRINTING, PRINTING, CUT_STARTING, KNIFE_OUT, KNIFE_HOME, KNIFE_HOME, KNIFE_HOME];

/**
 * Answers the K8's queries on the bulk pipe and its Printer Status vendor request on the control
 * pipe. The status is built from the sensors the page can simulate, so the driver's own bit parsing
 * and fault checks are what run.
 */
class MockK8 {
  paperLow = false;
  paperOut = false;
  jam = false;
  #pending: Uint8Array[] = [];
  #timeline: { byte0: number; byte2: number }[] = [];

  readonly transport: K8Transport = {
    isOpen: true,
    write: (data: Uint8Array) => this.#write(data),
    read: () => Promise.resolve(this.#pending.shift() ?? null),
    readUntil: () => Promise.reject(new Error("the K8 frames its own reads")),
    close: () => {
      (this.transport as { isOpen: boolean }).isOpen = false;
      return Promise.resolve();
    },
    controlTransfer: (_type: number, _request: number, _value: number, _index: number, data?: Uint8Array) => {
      if (data) data.set(this.#status());
      return Promise.resolve(data?.length ?? 0);
    },
  } as unknown as K8Transport;

  /** The cable is pulled: the driver sees a closed transport on its next exchange. */
  unplug(): void {
    (this.transport as { isOpen: boolean }).isOpen = false;
  }

  #write(data: Uint8Array): void {
    const reply = REPLIES[key(data)];
    if (reply) this.#pending.push(reply);
    if (data.length === 2 && data[0] === 0x1b && data[1] === 0x69) this.#timeline = [...PRINT_TIMELINE];
  }

  #status(): Uint8Array {
    const phase = this.#timeline.shift() ?? { byte0: 0, byte2: 0 };
    const error = this.paperOut || this.jam;
    const raw = new Uint8Array(6);
    // Byte 1 bit 2 is the black-mark sensor, lit on the bench unit's stock; byte 2 is 0x06 there.
    raw[0] = 0x04 | phase.byte0 | (this.paperLow ? 0x01 : 0) | (this.paperOut ? 0x02 : 0) | (this.jam ? 0x40 : 0);
    raw[1] = 0x06;
    raw[2] = phase.byte2 | (this.paperLow ? 0x40 : 0) | (error ? 0x80 : 0);
    raw[3] = (this.jam ? 0x01 : 0) | (this.paperOut ? 0x10 : 0);
    return raw;
  }
}

// ---------------------------------------------------------------------------------------------
// The test page
// ---------------------------------------------------------------------------------------------

/** 8" stock spans dots 0 to about 2400 of the head's 2592. */
const STOCK_DOTS = 2400;

/** A 70 mm page: a border, and a band of 96-dot squares across the middle. */
function testPattern(): RasterImage {
  const height = MIN_PAGE_ROWS;
  const data = new Uint8Array(BYTES_PER_ROW * height);
  const dot = (x: number, y: number) => (data[y * BYTES_PER_ROW + (x >> 3)] |= 0x80 >> (x & 7));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < STOCK_DOTS; x++) {
      const border = x < 24 || x >= STOCK_DOTS - 24 || y < 24 || y >= height - 24;
      const band = y >= 317 && y < 509 && x >= 96 && x < STOCK_DOTS - 96 && (Math.floor(x / 96) + Math.floor(y / 96)) % 2 === 0;
      if (border || band) dot(x, y);
    }
  }
  return { width: BYTES_PER_ROW * 8, height, data };
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export type Status = "closed" | "opening" | "open";

let printer: K8 | null = null;
let transport: K8Transport | null = null;
let mockK8: MockK8 | null = null;
let status: Status = "closed";
let mock = false;
let identity: { serialNumber: string; model: string; firmware: string; firmwareDate: string; twoSided: boolean } | null = null;
/** The configuration's paper width code, as the driver's `K8Config` documents it. */
const PAPER_WIDTH = ['6.125"', '7.38"', '8.0"', "A4", '8.5"'];
let config: { density: number; documentLength: number; blackMark: boolean; paperWidth: string } | null = null;
/** The last status read: the faults that stop a page, and every bit set, for the page to show. */
let paper: { faults: string[]; set: string[]; raw: string } | null = null;

const usbId = [VID, PID].map((id) => id.toString(16).padStart(4, "0")).join(":");

export const state = () => ({ status, mock, usbId, identity, config, paper });

const tell = () => announce("k8", state());

export function configure(options: { mock: boolean }): void {
  // A device opened in one mode must never carry on into the other.
  if (status !== "closed") throw new Error("Disconnect before changing mode");
  mock = options.mock;
  tell();
}

function take(read: K8Status): void {
  const hex = [...read.raw].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const set = Object.entries(read).filter(([name, on]) => name !== "raw" && on === true).map(([name]) => name);
  paper = { faults: faults(read), set, raw: hex };
}

/** Close a transport, whatever state it is in. Its close may be sync or async, and may throw. */
const release = (link: K8Transport | null) => Promise.resolve().then(() => link?.close()).catch(() => {});

function forget(): void {
  printer = null;
  transport = null;
  mockK8 = null;
  identity = null;
  config = null;
  paper = null;
}

/** Runs a command; a lost USB link closes the session rather than leaving it claiming to be open. */
async function using<T>(work: (open: K8) => Promise<T>): Promise<T> {
  if (!printer) throw new Error("Not connected");
  const open = printer;
  try {
    return await work(open);
  }
  catch (err) {
    if (err instanceof ConnectionLost && printer === open) {
      await release(transport);
      forget();
      status = "closed";
      tell();
      log("error", `${err.message}. Reconnect to continue.`);
    }
    throw err;
  }
}

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();
  log("info", mock ? "Opening mock K8" : `Opening ${usbId} over USB`);
  try {
    if (mock) {
      mockK8 = new MockK8();
      transport = mockK8.transport;
    }
    else {
      const usb = new USBTransport(VID, PID);
      transport = usb;
      await usb.open();
    }
    printer = new K8(transport);
    // A reply a previous session gave up on would otherwise be taken as identify's.
    await printer.drain();
    identity = await printer.identify();
    const read = await printer.config();
    config = {
      density: read.density,
      documentLength: read.documentLength,
      blackMark: read.blackMark,
      paperWidth: PAPER_WIDTH[read.paperWidth] ?? `code ${read.paperWidth}`,
    };
    take(await printer.status());
  }
  catch (err) {
    await release(transport);
    forget();
    status = "closed";
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  status = "open";
  tell();
  log("ok", `${identity.model} answered · firmware ${identity.firmware} · serial ${identity.serialNumber}`);
  if (paper?.faults.length) log("warned", `Printer reports ${paper.faults.join(", ")}`);
}

export async function disconnect(): Promise<void> {
  const open = transport;
  if (!printer || !open) return;
  printer = null;
  status = "closed";
  // Nothing to darken: the printer is idle once its last page is cut.
  await release(open);
  forget();
  tell();
  log("info", "Printer released");
}

async function readStatus(): Promise<void> {
  const read = await using((open) => open.status());
  const before = paper?.faults.join(", ");
  take(read);
  tell();
  const now = paper!.faults.join(", ");
  if (now !== before) log(now ? "warned" : "ok", now ? `Printer reports ${now}` : "No faults");
}

async function printTest(): Promise<void> {
  log("sent", "Printing the test page");
  try {
    take(await using((open) => open.printPage(testPattern())));
  }
  catch (err) {
    // A fault refused the page or stopped it: show the printer's state, then let the page say why.
    if (printer) await readStatus().catch(() => {});
    throw err;
  }
  tell();
  log("ok", "Test page printed and cut");
}

/** Printer Recovery 1: clears the buffers and leaves an error state once its cause is gone. */
async function recover(): Promise<void> {
  await using((open) => open.recover());
  log("sent", "Recovery requested");
  await readStatus();
}

const SIMULATIONS = ["paper-low", "paper-out", "jam", "clear", "unplug"] as const;
type Simulation = typeof SIMULATIONS[number];

/** Change the mock printer's sensors. The page offers this only when mocking. */
async function simulate(action: Simulation): Promise<void> {
  if (!mock || !mockK8) throw new Error("Only a mock printer has simulated paper");
  if (action === "paper-low") mockK8.paperLow = true;
  else if (action === "paper-out") mockK8.paperOut = true;
  else if (action === "jam") mockK8.jam = true;
  else if (action === "unplug") mockK8.unplug();
  else mockK8.paperLow = mockK8.paperOut = mockK8.jam = false;
  await readStatus();
}

export const actions: Record<string, (body: Record<string, unknown>) => unknown> = {
  status: () => readStatus(),
  "print-test": () => printTest(),
  recover: () => recover(),
  simulate: ({ action }) => {
    if (!SIMULATIONS.includes(action as Simulation)) throw new Error(`'${action}' is not a simulation`);
    return simulate(action as Simulation);
  },
};

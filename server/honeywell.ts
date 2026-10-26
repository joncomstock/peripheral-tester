/**
 * The Honeywell 5X80 (IT5180), as one device of the tester: the SITA D4's barcode reader.
 *
 * Reached the way the kiosks run it and `@eai/honeywell`'s README documents: the scanner in USB
 * serial (CDC-ACM) mode on the OS's own driver, opened with `SerialTransport`. The driver's own
 * Deno `connect()` goes over libusb instead, which needs the interface bound to WinUSB; nothing on a
 * D4 is set up that way. There is no 5X80 class: it is the base `HoneywellScanner` with the 5X80's
 * presentation mode, `TRGMOD4`.
 *
 * What this drives: presentation reading (Listen), a single serial-triggered read, the beeper, and
 * the identity the scanner reports (REVINF). Every setting is sent with the `!` storage character,
 * applied until power-off and never saved, so the tester leaves a kiosk's saved configuration alone.
 * Left out on purpose: `reset()` and `factoryReset()` (they overwrite the saved configuration and
 * clear the suffix the read loop frames on), symbology restriction (saved, and the driver keeps its
 * symbology list to itself), and raw commands.
 *
 * The symbology is the Honeywell Code ID, which this module turns on as a prefix while connected
 * and clears on disconnect: the driver hands up only the decoded text. A barcode is usually a
 * boarding pass, which carries a passenger's name and booking. The log is told one was read and its
 * symbology, never its text; the text goes to the page in state.
 *
 * @module
 */

import type { Transport } from "@eai/models";
import { HoneywellScanner, SYN_M_CR, TRIGGER_START, TRIGGER_STOP } from "@eai/honeywell";
import { findPortForUsbDevice, SerialTransport } from "@eai/serial";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("honeywell", kind, text);

/**
 * The 5X80's USB ids in its USB serial mode. Not exported by the driver, which knows only the N56xx
 * (0c2e:096a); these are the ids hardware-libs' models list for the IT5180 (Hand Held Products).
 */
const VENDOR_ID = 0x0536;
const PRODUCT_ID = 0x030a;
const usbId = [VENDOR_ID, PRODUCT_ID].map((id) => id.toString(16).padStart(4, "0")).join(":");

/** The 5X80 presents with TRGMOD4; the driver's default (3) is the N56xx's. */
const CONFIG = { presentationCommand: "TRGMOD4" };

/** End every decode with ETX, which the driver's read loops frame on: what its connect helpers send. */
const SUFFIX = "SUFCA2;SUFBK29903";
/** Clear every prefix, then put the Code ID before every symbology's decode. */
const CODE_ID_PREFIX = "PRECA2;PREBK2995C80";

/** Honeywell Code IDs (the 5X80 user guide's symbology chart), for the symbologies a kiosk meets. */
const CODE_IDS: Record<string, string> = {
  a: "Codabar",
  b: "Code 39",
  c: "UPC-A",
  d: "EAN-13",
  D: "EAN-8",
  E: "UPC-E",
  e: "Interleaved 2 of 5",
  i: "Code 93",
  I: "GS1-128",
  j: "Code 128",
  r: "PDF417",
  R: "MicroPDF417",
  s: "QR Code",
  w: "Data Matrix",
  x: "MaxiCode",
  y: "GS1 DataBar",
  z: "Aztec",
};

/** BEPLVL's values, by index. */
const BEEPER_VOLUMES = ["Off", "Low", "Medium", "High"];

// ---------------------------------------------------------------------------------------------
// A fake scanner, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

/** A fabricated boarding pass (IATA BCBP): no real passenger or booking. */
const DEMO_BOARDING_PASS = "M1TESTER/MOCK        ETEST01 YYZYVRAC 0000 300Y001A0001 100";
const DEMO_QR = "MOCK QR https://example.invalid/checkin/TEST01";

/** A REVINF reply, abridged. The "." in the revisions is what the driver's reply framing must survive. */
const DEMO_REVINF = [
  "Product Name: 5X80 Mock Scanner",
  "Boot Revision: BOOT-MOCK 1.00",
  "Software Part Number: MOCK-SW-0001",
  "Software Revision: 1.02",
  "Serial Number: MOCK00000001",
].join("\r\n");

const ACK = "\x06";
const ENQ = "\x05";

/**
 * Speaks the SYN M CR protocol as a byte stream, the way the serial port delivers it: each command
 * echoed with a status byte before each separator and the storage character, decodes ending in ETX
 * (with the Code ID first, once the prefix is set). It reads only while the driver has put it in a
 * reading mode, as the scanner does.
 */
class MockScanner implements Transport {
  isOpen = true;
  #buffer = new Uint8Array(0);
  #waiter: (() => void) | null = null;
  #settings: Record<string, string> = { BEPBEP: "1", BEPLVL: "3", TRGMOD: "0", TRGSTO: "30000" };
  #codeId = false;
  /** Until when a serial trigger keeps it reading; presentation mode reads until told to stop. */
  #triggeredUntil = 0;
  #enc = new TextEncoder();

  /** Something presented to the window. */
  scan(kind: "boarding-pass" | "qr"): void {
    const presenting = this.#settings.TRGMOD === "4";
    if (!presenting && Date.now() > this.#triggeredUntil) {
      throw new Error("The scanner is not reading: Listen or Single read first");
    }
    this.#triggeredUntil = 0;
    const [code, text] = kind === "qr" ? ["s", DEMO_QR] : ["r", DEMO_BOARDING_PASS];
    this.#push(`${this.#codeId ? code : ""}${text}\x03`);
  }

  #push(text: string): void {
    const bytes = this.#enc.encode(text);
    const next = new Uint8Array(this.#buffer.length + bytes.length);
    next.set(this.#buffer);
    next.set(bytes, this.#buffer.length);
    this.#buffer = next;
    this.#waiter?.();
  }

  write(data: Uint8Array): void {
    if (!this.isOpen) throw new Error("the port is not open");
    if (data[0] !== SYN_M_CR[0]) return;
    if (data[1] === TRIGGER_START[1]) {
      this.#triggeredUntil = Date.now() + Number(this.#settings.TRGSTO);
      return;
    }
    if (data[1] === TRIGGER_STOP[1]) {
      this.#triggeredUntil = 0;
      return;
    }
    const text = new TextDecoder().decode(data.subarray(SYN_M_CR.length));
    const storage = text.slice(-1);
    this.#push(text.slice(0, -1).split(";").map((item) => this.#answer(item)).join(";") + storage);
  }

  #answer(item: string): string {
    if (item === "REVINF") return `${DEMO_REVINF}\r\nREVINF${ACK}`;
    if (item === "PRECA2") this.#codeId = false;
    else if (item === "PREBK2995C80") this.#codeId = true;
    else if (item === "BEP?") return `BEPBEP${this.#settings.BEPBEP}${ACK},LVL${this.#settings.BEPLVL}${ACK}`;
    else if (item.endsWith("?")) {
      const tag = item.slice(0, -1);
      return tag in this.#settings ? `${tag}${this.#settings[tag]}${ACK}` : `${item}${ENQ}`;
    }
    else if (item.slice(0, 6) in this.#settings) this.#settings[item.slice(0, 6)] = item.slice(6);
    else if (!item.startsWith("SUF")) return `${item}${ENQ}`;
    return `${item}${ACK}`;
  }

  read(): Promise<Uint8Array | null> {
    return Promise.reject(new Error("the driver reads by delimiter"));
  }

  readUntil(delimiter: Uint8Array, timeout = 1000, signal?: AbortSignal): Promise<Uint8Array | null> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (frame: Uint8Array | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#waiter = null;
        resolve(frame);
      };
      const onAbort = () => finish(null);
      const attempt = () => {
        // The driver frames only on single bytes: ".", "!" and ETX.
        const at = this.#buffer.indexOf(delimiter[0]);
        if (at !== -1) {
          const frame = this.#buffer.slice(0, at);
          this.#buffer = this.#buffer.slice(at + 1);
          finish(frame);
        }
        else if (!this.isOpen || signal?.aborted) finish(null);
      };
      this.#waiter = attempt;
      signal?.addEventListener("abort", onAbort, { once: true });
      // monitor() waits without end (MAX_SAFE_INTEGER), which a timer cannot hold.
      if (timeout < 2 ** 31) timer = setTimeout(() => finish(null), timeout);
      attempt();
    });
  }

  close(): void {
    this.isOpen = false;
    this.#waiter?.();
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export type Status = "closed" | "opening" | "open";
export type Mode = "idle" | "listening" | "single";

let scanner: HoneywellScanner | null = null;
/** Held to tell a port that went away from a refused command: the driver reports no unplug. */
let transport: Transport | null = null;
let mockScanner: MockScanner | null = null;
let status: Status = "closed";
let mock = false;
let mode: Mode = "idle";
let barcode: { symbology: string | null; text: string } | null = null;
/** As the scanner last reported it. */
let beeper: { on: boolean; volume: number } | null = null;
let singleTimer: ReturnType<typeof setTimeout> | undefined;

export const state = () => ({
  status,
  mock,
  usbId,
  mode,
  barcode,
  beeper,
  beeperVolumes: BEEPER_VOLUMES,
});

const tell = () => announce("honeywell", state());

export function configure(options: { mock: boolean }): void {
  // A device opened in one mode must never carry on into the other.
  if (status !== "closed") throw new Error("Disconnect before changing mode");
  mock = options.mock;
  tell();
}

/** A decode, split into its Code ID and the text. */
function decode(frame: string): { symbology: string | null; text: string } {
  const code = frame[0];
  return { symbology: CODE_IDS[code] ?? `Code ID "${code}"`, text: frame.slice(1) };
}

function wire(opened: HoneywellScanner): void {
  opened.on("data", (frame: string) => {
    if (scanner !== opened) return;
    barcode = decode(frame);
    if (mode === "single") {
      clearTimeout(singleTimer);
      mode = "idle";
    }
    // The symbology and length, never the text: a boarding pass carries a passenger's name.
    log("ok", `Barcode read — ${barcode.symbology}, ${barcode.text.length} characters`);
    tell();
  });
}

async function readBeeper(opened: HoneywellScanner): Promise<void> {
  const values = await opened.query("BEP");
  beeper = values.BEP !== undefined && values.LVL !== undefined ? { on: values.BEP === "1", volume: Number(values.LVL) } : null;
}

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();
  log("info", mock ? "Opening mock 5X80" : `Opening ${usbId} over USB serial`);
  let opened: HoneywellScanner | null = null;
  try {
    if (mock) {
      mockScanner = new MockScanner();
      transport = mockScanner;
    }
    else {
      const port = await findPortForUsbDevice({ vendorId: VENDOR_ID, productId: PRODUCT_ID });
      if (!port) throw new Error(`No serial port for ${usbId}: is the scanner plugged in and in USB serial mode?`);
      const serial = new SerialTransport({ port });
      serial.open();
      transport = serial;
    }
    opened = new HoneywellScanner(transport, mock ? "HoneywellScanner:mock" : "HoneywellScanner", CONFIG);
    await opened.issueCommand(SUFFIX);
    await opened.issueCommand(CODE_ID_PREFIX, "!");
    await readBeeper(opened);
    wire(opened);
  }
  catch (err) {
    await opened?.close().catch(() => {});
    transport = null;
    mockScanner = null;
    beeper = null;
    status = "closed";
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  scanner = opened;
  status = "open";
  tell();
  log("ok", "Scanner answered; decodes end in ETX and carry their Code ID");
}

/** Forget the scanner. The handle is closed without writing: whatever is left of it is gone. */
function lost(open: HoneywellScanner): void {
  clearTimeout(singleTimer);
  scanner = null;
  transport = null;
  mockScanner = null;
  status = "closed";
  mode = "idle";
  beeper = null;
  open.close().catch(() => {});
  log("error", "The scanner's port closed. Reconnect to continue.");
  tell();
}

export async function disconnect(): Promise<void> {
  const open = scanner;
  if (!open) return;
  clearTimeout(singleTimer);
  scanner = null;
  status = "closed";
  // Leave it dark (manual trigger, not reading) and its decodes as the kiosk expects them.
  try {
    await open.deactivate();
    if (transport?.isOpen) await open.issueCommand("PRECA2", "!");
  }
  catch { /* a scanner already unreachable cannot be quietened */ }
  await open.close();
  transport = null;
  mockScanner = null;
  mode = "idle";
  barcode = null;
  beeper = null;
  tell();
  log("info", "Scanner released");
}

function held(): HoneywellScanner {
  if (!scanner || !transport) throw new Error("Not connected");
  if (!transport.isOpen) {
    lost(scanner);
    throw new Error("The scanner's port closed. Reconnect to continue.");
  }
  return scanner;
}

/** The scanner, when nothing is reading: a read loop takes every byte, so a command's reply would be lost to it. */
function idle(): HoneywellScanner {
  const open = held();
  if (mode !== "idle") throw new Error("Stop reading first");
  return open;
}

/** Fails when any command in a reply was refused: ENQ is an unknown tag, NAK a value out of range. */
function accepted(reply: string): void {
  if (reply.includes("\x15") || reply.includes("=0")) {
    throw new Error(`The scanner refused it (${reply.replaceAll("\x15", " out of range").replaceAll("=0", " unknown")})`);
  }
}

async function listen(): Promise<void> {
  await idle().monitor();
  mode = "listening";
  tell();
  log("sent", "Presentation mode: reading every code presented");
}

async function singleRead(seconds: unknown): Promise<void> {
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1 || seconds > 30) {
    throw new Error("seconds must be a whole number from 1 to 30");
  }
  const open = idle();
  await open.activate(seconds * 1000);
  mode = "single";
  tell();
  log("sent", `Triggered a single read, up to ${seconds} s`);
  // The driver ends the read itself at the time-out and says nothing; a little after it, so does this.
  singleTimer = setTimeout(() => {
    if (scanner !== open || mode !== "single") return;
    mode = "idle";
    tell();
    log("warned", `Nothing read within ${seconds} s`);
  }, seconds * 1000 + 250);
}

async function stop(): Promise<void> {
  const open = held();
  clearTimeout(singleTimer);
  await open.deactivate();
  mode = "idle";
  tell();
  log("sent", "Stopped reading; manual trigger mode");
}

async function setBeeper(body: Record<string, unknown>): Promise<void> {
  const { on, volume } = body;
  if (on !== undefined && typeof on !== "boolean") throw new Error("on must be true or false");
  if (volume !== undefined && (typeof volume !== "number" || !Number.isInteger(volume) || !BEEPER_VOLUMES[volume])) {
    throw new Error(`volume must be 0 to ${BEEPER_VOLUMES.length - 1}`);
  }
  const commands = [on === undefined ? null : `BEPBEP${on ? 1 : 0}`, volume === undefined ? null : `BEPLVL${volume}`].filter(Boolean);
  if (commands.length === 0) throw new Error("on or volume is required");
  const open = idle();
  accepted(await open.issueCommand(commands.join(";"), "!"));
  await readBeeper(open);
  tell();
  log("sent", `Beeper ${beeper?.on ? "on" : "off"}, volume ${BEEPER_VOLUMES[beeper?.volume ?? -1] ?? "unknown"} (until power-off)`);
}

/** REVINF's "Label: value" pairs, without the version-control noise ($ProjectRevision: … $). */
async function identity(): Promise<{ identity: { label: string; value: string }[] }> {
  const reply = await idle().issueCommand("REVINF");
  const fields: { label: string; value: string }[] = [];
  for (const line of reply.split(/\r?\n/)) {
    // An engine line packs several pairs, separated by runs of spaces.
    for (const pair of line.split(/\s{2,}/)) {
      const at = pair.indexOf(":");
      if (at < 0) continue;
      const value = pair.slice(at + 1).replace(/\$\w+:/g, "").replace(/\$/g, "").replace(/^[\s:]+/, "").trim();
      fields.push({ label: pair.slice(0, at).trim(), value });
    }
  }
  const named = (label: string) => fields.find((field) => field.label === label)?.value;
  log("info", `${named("Product Name") ?? "Scanner"} · software ${named("Software Revision") ?? "unknown"}`);
  return { identity: fields };
}

/** Present a fake code to the mock scanner's window. */
function simulate(code: unknown): void {
  if (!mock || !mockScanner) throw new Error("Only a mock scanner has a simulated window");
  if (code !== "boarding-pass" && code !== "qr") throw new Error(`unknown code '${code}'`);
  mockScanner.scan(code);
}

export const actions: Record<string, (body: Record<string, unknown>) => unknown> = {
  listen: () => listen(),
  "single-read": (body) => singleRead(body.seconds),
  stop: () => stop(),
  beeper: (body) => setBeeper(body),
  identity: () => identity(),
  simulate: (body) => simulate(body.code),
};

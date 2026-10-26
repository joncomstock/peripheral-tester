/**
 * The Honeywell 5X80 (IT5180), as one device of the tester: the SITA D4's barcode reader.
 *
 * Reached the way the kiosks run it and `@eai/honeywell`'s README documents: the scanner in USB
 * serial (CDC-ACM) mode on the OS's own driver, opened with `SerialTransport`. The driver's own
 * Deno `connect()` goes over libusb instead, which needs the interface bound to WinUSB; nothing on a
 * D4 is set up that way. There is no 5X80 class: it is the base `HoneywellScanner`, whose
 * `issueCommand` this uses; the 5X80 presents with `TRGMOD4`.
 *
 * What this drives: presentation reading (Listen), a single serial-triggered read, the beeper, and
 * the identity the scanner reports (REVINF). Every command this session sends carries the `!`
 * storage character: applied until power-off, never written to the scanner's flash, so a kiosk's
 * saved configuration is never touched. That is why it does not call the driver's `monitor()`,
 * `activate()`, `deactivate()` or `query()`: they send with `.`, which saves. Their read loops are
 * mirrored here instead. Until the next power-off, a single read leaves its time-out (`TRGSTO`)
 * set, the beeper stays as set, and Stop or Disconnect leaves manual trigger (`TRGMOD0`): the kiosk
 * app sets its own mode when it starts reading. Left out on purpose: `reset()` and `factoryReset()`
 * (they overwrite the saved configuration), symbology restriction (the driver saves it), and raw
 * commands.
 *
 * Decodes are framed on an ETX suffix, and the symbology is the Honeywell Code ID sent as a prefix.
 * Connect reads the kiosk's prefixes and suffixes, replaces them with those two while connected, and
 * Disconnect puts back exactly what it read. If the scanner's answer is not understood, they are
 * left alone: decodes then carry no symbology, and reads end only if the suffix already is ETX.
 *
 * A barcode is usually a boarding pass, which carries a passenger's name and booking. The log is
 * told one was read and its symbology, never its text; the text goes to the page in state.
 *
 * @module
 */

import type { Transport } from "@eai/models";
import { ETX, HoneywellScanner, SYN_M_CR, TRIGGER_START, TRIGGER_STOP } from "@eai/honeywell";
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

/** Until power-off: everything this session sends. `.` would save it to flash. */
const VOLATILE = "!";

/** The 5X80's presentation mode; the driver's default (3) is the N56xx's. */
const PRESENTING = "TRGMOD4";
const MANUAL_TRIGGER = "TRGMOD0";

/** The current prefixes and suffixes, as `PREBK2`/`SUFBK2` entries (symbology id + hex bytes). */
const FRAMING_QUERY = "PREBK2?;SUFBK2?";
/** Clear every prefix and suffix, then the Code ID before and ETX after every symbology's decode. */
const FRAMING = "PRECA2;PREBK2995C80;SUFCA2;SUFBK29903";

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

/** Every SYN M CR command a mock scanner received, storage character included: for the test. */
export const mockCommands: string[] = [];

/** Hex pairs as text: a prefix or suffix entry's bytes. */
const unhex = (hex: string) => hex.replace(/../g, (pair) => String.fromCharCode(parseInt(pair, 16)));

/**
 * Speaks the SYN M CR protocol as a byte stream, the way the serial port delivers it: each command
 * echoed with a status byte before each separator and the storage character sent, decodes wrapped
 * in the prefixes and suffixes set (the Code ID among them). It starts as a kiosk app might leave
 * it, with an STX prefix of its own. It reads only while put in a reading mode, as the scanner does.
 */
class MockScanner implements Transport {
  isOpen = true;
  #buffer = new Uint8Array(0);
  #waiter: (() => void) | null = null;
  #settings: Record<string, string> = { BEPBEP: "1", BEPLVL: "3", TRGMOD: "0", TRGSTO: "30000" };
  /** `PREBK2`/`SUFBK2` entries: symbology id (99: all) and hex bytes, 5C80 being the Code ID. */
  #framing: Record<"PRE" | "SUF", string[]> = { PRE: ["9902"], SUF: ["9903"] };
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
    const bytes = (entries: string[]) => entries.map((entry) => entry.slice(2) === "5C80" ? code : unhex(entry.slice(2))).join("");
    this.#push(`${bytes(this.#framing.PRE)}${text}${bytes(this.#framing.SUF)}`);
  }

  /** The cable is pulled. */
  unplug(): void {
    this.close();
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
    mockCommands.push(text);
    const storage = text.slice(-1);
    this.#push(text.slice(0, -1).split(";").map((item) => this.#answer(item)).join(";") + storage);
  }

  #answer(item: string): string {
    if (item === "REVINF") return `${DEMO_REVINF}\r\nREVINF${ACK}`;
    const tag = item.slice(0, 3) as "PRE" | "SUF";
    if (tag === "PRE" || tag === "SUF") {
      const entries = this.#framing[tag];
      // Each entry after the first as a subtag, without its tag, as the scanner lists them.
      if (item.slice(3) === "BK2?") return `${tag}BK2${entries.map((entry) => `${entry}${ACK}`).join(",BK2") || ACK}`;
      if (item.slice(3) === "CA2") entries.length = 0;
      else if (item.slice(3, 6) === "BK2" && /^([0-9A-F]{2})+$/.test(item.slice(6))) entries.push(item.slice(6));
      else return `${item}${ENQ}`;
    }
    else if (item === "BEP?") return `BEPBEP${this.#settings.BEPBEP}${ACK},LVL${this.#settings.BEPLVL}${ACK}`;
    else if (item.endsWith("?")) {
      const tag = item.slice(0, -1);
      return tag in this.#settings ? `${tag}${this.#settings[tag]}${ACK}` : `${item}${ENQ}`;
    }
    else if (item.slice(0, 6) in this.#settings) this.#settings[item.slice(0, 6)] = item.slice(6);
    else return `${item}${ENQ}`;
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
        // Everything here frames on single bytes: "!" and ETX.
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
      // Listening waits without end (MAX_SAFE_INTEGER), which a timer cannot hold.
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
/** Held to read decodes and send the trigger, and to tell a port that went away: the driver reports no unplug. */
let transport: Transport | null = null;
let mockScanner: MockScanner | null = null;
let status: Status = "closed";
let mock = false;
let mode: Mode = "idle";
let barcode: { symbology: string | null; text: string } | null = null;
/** As the scanner last reported it. */
let beeper: { on: boolean; volume: number } | null = null;
/** The commands that put back the kiosk's prefixes and suffixes; null when they were left alone. */
let restoreFraming: string | null = null;
/** True once Listen or a single read changed the trigger mode: only then is manual trigger set back. */
let modeEntered = false;
let reading: { controller: AbortController; task: Promise<void> } | null = null;

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

/** A decode, split into its Code ID and the text when the Code ID prefix is on. */
function decode(frame: string): { symbology: string | null; text: string } {
  if (restoreFraming === null) return { symbology: null, text: frame };
  const code = frame[0];
  return { symbology: CODE_IDS[code] ?? `Code ID "${code}"`, text: frame.slice(1) };
}

function received(frame: string): void {
  barcode = decode(frame);
  // The symbology and length, never the text: a boarding pass carries a passenger's name.
  log("ok", `Barcode read — ${barcode.symbology ?? "symbology unknown"}, ${barcode.text.length} characters`);
  tell();
}

/** Fails when any command in a reply was refused: ENQ is an unknown tag, NAK a value out of range. */
function accepted(reply: string): void {
  if (reply.includes("\x15") || reply.includes("=0")) {
    throw new Error(`The scanner refused it (${reply.replaceAll("\x15", " out of range").replaceAll("=0", " unknown")})`);
  }
}

/**
 * The commands that set the prefixes and suffixes back to what a `FRAMING_QUERY` reply reports, or
 * null if the reply is not one this can read back exactly. Entries after the first in a tag come as
 * subtags without the tag (`PREBK2…=1,BK2…=1`); an empty one (`PREBK2=1`) means none is set.
 */
function framingRestore(reply: string): string | null {
  const commands = ["PRECA2", "SUFCA2"];
  const groups = reply.split(";");
  if (groups.length !== 2) return null;
  for (const [at, group] of groups.entries()) {
    const tag = at === 0 ? "PRE" : "SUF";
    for (const [index, part] of group.split(",").entries()) {
      const entry = (index === 0 ? "" : tag) + part;
      const found = entry.match(/^(PRE|SUF)BK2((?:[0-9A-Fa-f]{2})*)=1$/);
      if (!found || found[1] !== tag) return null;
      if (found[2]) commands.push(`${tag}BK2${found[2]}`);
    }
  }
  return commands.join(";");
}

async function readBeeper(open: HoneywellScanner): Promise<void> {
  // The driver's query(), with `!`: it sends with `.`.
  const pairs = (await open.issueCommand("BEP?", VOLATILE)).substring(3).replace(/=1/g, "").split(",");
  const values = Object.fromEntries(pairs.map((pair) => [pair.substring(0, 3), pair.substring(3)]));
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
    opened = new HoneywellScanner(transport, mock ? "HoneywellScanner:mock" : "HoneywellScanner");
    restoreFraming = framingRestore(await opened.issueCommand(FRAMING_QUERY, VOLATILE));
    if (restoreFraming === null) {
      log(
        "warned",
        "The scanner's prefixes and suffixes could not be read back exactly, so they are left alone: no symbology, and reads end only if its suffix is ETX",
      );
    }
    else accepted(await opened.issueCommand(FRAMING, VOLATILE));
    await readBeeper(opened);
  }
  catch (err) {
    await opened?.close().catch(() => {});
    transport = null;
    mockScanner = null;
    beeper = null;
    restoreFraming = null;
    status = "closed";
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  scanner = opened;
  modeEntered = false;
  status = "open";
  tell();
  log("ok", restoreFraming ? "Scanner answered; decodes end in ETX and carry their Code ID until disconnect" : "Scanner answered");
}

/** Forget the scanner. The handle is closed without writing: whatever is left of it is gone. */
function lost(open: HoneywellScanner): void {
  if (scanner !== open) return;
  reading?.controller.abort();
  reading = null;
  scanner = null;
  transport = null;
  mockScanner = null;
  restoreFraming = null;
  status = "closed";
  mode = "idle";
  beeper = null;
  open.close().catch(() => {});
  log("error", "The scanner's port closed. Reconnect to continue.");
  tell();
}

/** Work on the scanner's port; one that failed with the port closed means the scanner is gone. */
async function guarded<T>(open: HoneywellScanner, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  }
  catch (err) {
    if (!transport?.isOpen) lost(open);
    throw err;
  }
}

const send = (open: HoneywellScanner, command: string) => guarded(open, () => open.issueCommand(command, VOLATILE));

/**
 * Read decodes off the port, as the driver's `monitor()` (`once` false) and `activate()` (`once`
 * true) loops do. Theirs cannot be used: both first send their mode command with `.`, saving it.
 * A loop that ends on its own while listening, or fails, means the port is gone; a single read that
 * ends without a decode timed out.
 */
function startReading(open: HoneywellScanner, port: Transport, timeout: number, once: boolean): void {
  const controller = new AbortController();
  const task = (async () => {
    let ended = "nothing";
    try {
      do {
        const frame = await port.readUntil(ETX, timeout, controller.signal);
        // stop()/disconnect() abort and then await this; a frame completing after belongs to the session torn down.
        if (controller.signal.aborted) return;
        if (frame === null) break;
        if (frame.length > 0) received(new TextDecoder().decode(frame));
        ended = "decode";
      }
      while (!once);
    }
    catch {
      if (controller.signal.aborted) return;
      ended = "error";
    }
    reading = null;
    if (scanner !== open) return;
    if (!once || ended === "error" || !port.isOpen) return lost(open);
    mode = "idle";
    tell();
    if (ended === "nothing") log("warned", `Nothing read within ${timeout / 1000} s`);
  })();
  reading = { controller, task };
}

/** Stop the read loop and wait for it, so a command's reply is not taken as a decode. */
async function stopReading(): Promise<void> {
  const current = reading;
  reading = null;
  current?.controller.abort();
  await current?.task;
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

async function listen(): Promise<void> {
  const open = idle();
  const port = transport!;
  accepted(await send(open, PRESENTING));
  modeEntered = true;
  startReading(open, port, Number.MAX_SAFE_INTEGER, false);
  mode = "listening";
  tell();
  log("sent", "Presentation mode: reading every code presented (until power-off)");
}

async function singleRead(seconds: unknown): Promise<void> {
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1 || seconds > 30) {
    throw new Error("seconds must be a whole number from 1 to 30");
  }
  const open = idle();
  const port = transport!;
  // What the driver's setSerialMode() sends, with `!`.
  accepted(await send(open, `${MANUAL_TRIGGER};TRGSTO${seconds * 1000}`));
  modeEntered = true;
  startReading(open, port, seconds * 1000, true);
  mode = "single";
  tell();
  await guarded(open, () => Promise.resolve(port.write(TRIGGER_START)));
  log("sent", `Triggered a single read, up to ${seconds} s`);
}

async function stop(): Promise<void> {
  const open = held();
  const port = transport!;
  await stopReading();
  // As the driver's deactivate(): stop a serial trigger, then manual trigger, here until power-off.
  await guarded(open, () => Promise.resolve(port.write(TRIGGER_STOP)));
  accepted(await send(open, MANUAL_TRIGGER));
  mode = "idle";
  tell();
  log("sent", "Stopped reading; manual trigger mode (until power-off)");
}

export async function disconnect(): Promise<void> {
  const open = scanner;
  const port = transport;
  if (!open || !port) return;
  scanner = null;
  status = "closed";
  await stopReading();
  // Leave it dark (manual trigger, not reading) and its decodes framed as the kiosk had them.
  try {
    if (port.isOpen) {
      if (modeEntered) await port.write(TRIGGER_STOP);
      const restore = [modeEntered ? MANUAL_TRIGGER : null, restoreFraming].filter(Boolean).join(";");
      if (restore) accepted(await open.issueCommand(restore, VOLATILE));
    }
  }
  catch (err) {
    log("warned", `Could not put the scanner's settings back: ${err instanceof Error ? err.message : err}`);
  }
  await open.close();
  transport = null;
  mockScanner = null;
  restoreFraming = null;
  mode = "idle";
  barcode = null;
  beeper = null;
  tell();
  log("info", "Scanner released");
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
  accepted(await send(open, commands.join(";")));
  await guarded(open, () => readBeeper(open));
  tell();
  log("sent", `Beeper ${beeper?.on ? "on" : "off"}, volume ${BEEPER_VOLUMES[beeper?.volume ?? -1] ?? "unknown"} (until power-off)`);
}

/** REVINF's "Label: value" pairs, without the version-control noise ($ProjectRevision: … $). */
async function identity(): Promise<{ identity: { label: string; value: string }[] }> {
  const reply = await send(idle(), "REVINF");
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

/** Present a fake code to the mock scanner's window, or pull its cable. */
function simulate(code: unknown): void {
  if (!mock || !mockScanner) throw new Error("Only a mock scanner has a simulated window");
  if (code === "unplug") return mockScanner.unplug();
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

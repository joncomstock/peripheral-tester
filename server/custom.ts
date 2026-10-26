/**
 * The CUSTOM KPM150 / KPM180 thermal printer, as one device of the tester, in its CUSTOM/POS
 * emulation (the firmware without AEA), driven by `@eai/custom`'s `CustomPOS` directly rather
 * than through its AEA adapter.
 *
 * What it reaches: the full status (paper out, low, jammed, cover, a ticket waiting at the exit,
 * the error bits), the unit's identity and firmware release lines, and a raster test ticket. CUSTOM/POS
 * never reports on its own, so status is read when asked, on connect and after every print.
 * Left out on purpose: the silent-printer diagnosis (its `FS <EPOS>` step reboots the unit), the
 * reboot command, and the notch distance (stored in non-volatile memory with limited writes).
 * A unit running AEA firmware does not answer CUSTOM/POS, and connecting says so.
 *
 * @module
 */

import type { Transport } from "@eai/models";
import { USBTransport } from "@eai/usb";
import { ConnectionLost, CustomPOS, faults, MODEL_KPM180H, packBitmap, readFirmwareInfo } from "@eai/custom";
import type { CustomStatus, RasterImage } from "@eai/custom";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("custom", kind, text);

/** CUSTOM Engineering's vendor ID and the KPM180-H's product ID (PROTOCOL.md); the driver exports neither. */
const CUSTOM_VENDOR_ID = 0x0dd4;
const KPM180H_PRODUCT_ID = 0x0208;

// ---------------------------------------------------------------------------------------------
// The test ticket.
// ---------------------------------------------------------------------------------------------

/** 5 x 7 glyphs for the ticket's few letters, one string of five dots per row. */
const GLYPHS: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
};

/**
 * A framed "TEST TICKET / NOT VALID", 48 mm wide so it fits both the 50 mm tag and 80 mm pass
 * stock, packed by the driver's own `packBitmap`.
 */
export function sampleTicket(): RasterImage {
  const width = 384, height = 280, scale = 5, frame = 6;
  const pixels = new Uint8Array(width * height).fill(255);
  const ink = (x: number, y: number) => pixels[y * width + x] = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x < frame || y < frame || x >= width - frame || y >= height - frame) ink(x, y);
    }
  }
  ["TEST TICKET", "NOT VALID"].forEach((line, row) => {
    const left = Math.floor((width - line.length * 6 * scale) / 2);
    const top = 60 + row * 100;
    [...line].forEach((char, i) => {
      GLYPHS[char].forEach((dots, gy) => {
        [...dots].forEach((dot, gx) => {
          if (dot !== "1") return;
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) ink(left + (i * 6 + gx) * scale + dx, top + gy * scale + dy);
          }
        });
      });
    });
  });
  return packBitmap({ width, height, pixels });
}

// ---------------------------------------------------------------------------------------------
// A fake printer, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

const hex = (bytes: Uint8Array) => [...bytes.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
const ascii = (text: string) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

/** The bench KPM180-H's identification replies and firmware-info frame, from the driver's tests. */
const REPLIES: Record<string, Uint8Array> = {
  "1d 49 ff": Uint8Array.of(MODEL_KPM180H >> 8, MODEL_KPM180H & 0xff),
  "1d 49 02": Uint8Array.of(0x02),
  "1d 49 03": ascii("1.81"),
  "1c ea 52": ascii("MOCK000000000001"),
  "1f ff 02 18": ascii(
    "\x02<C2><4>\xba      KPM180-H ETH IBM printer      \xba\x00" +
      "\xba SCODE:SC000000000098  -   rel 1.81 \xba\x00" +
      "\xba DCODE:DC000000000029  -   rel 1.00 \xba\x00" +
      "\xba FCODE:FC000000000035  -   rel 1.01 \xba\x00\x03",
  ),
};

export type CustomSimulation = "paper-low" | "paper-out" | "jam" | "clear";

/**
 * A KPM180-H in CUSTOM/POS answering on its bulk pipe: the identification replies above, and the
 * `10 0F b1 b2 b3 b4` full status to `DLE EOT 0x14`. A cut leaves the printer busy for two status
 * reads, then a ticket at the exit, unless the paper is out or jammed.
 */
class MockPrinter implements Transport {
  isOpen = true;
  paperLow = false;
  paperOut = false;
  jam = false;
  ticketAtExit = false;
  #busyFor = 0;
  #pending: Uint8Array[] = [];

  simulate(condition: CustomSimulation): void {
    if (condition === "paper-low") this.paperLow = true;
    else if (condition === "paper-out") this.paperOut = true;
    else if (condition === "jam") this.jam = true;
    else {this.paperLow =
        this.paperOut =
        this.jam =
        this.ticketAtExit =
          false;}
  }

  write(data: Uint8Array): void {
    const key = hex(data);
    if (key.startsWith("10 04 14")) this.#pending.push(this.#status());
    else if (key.startsWith("1b 69")) {
      if (!this.paperOut && !this.jam) {
        this.#busyFor = 2;
        this.ticketAtExit = true;
      }
    }
    else if (REPLIES[key]) this.#pending.push(REPLIES[key]);
  }

  #status(): Uint8Array {
    const busy = this.#busyFor > 0;
    if (busy) this.#busyFor--;
    const paper = (this.paperOut ? 0x01 : 0) | (this.paperLow ? 0x04 : 0) | (this.ticketAtExit ? 0x20 : 0);
    return Uint8Array.of(0x10, 0x0f, paper, busy ? 0x0c : 0, this.jam ? 0x40 : 0, 0);
  }

  read(): Promise<Uint8Array | null> {
    return Promise.resolve(this.#pending.shift() ?? null);
  }

  readUntil(): Promise<Uint8Array | null> {
    return Promise.reject(new Error("CUSTOM/POS replies are read whole"));
  }

  close(): void {
    this.isOpen = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export type Status = "closed" | "opening" | "open";

let printer: CustomPOS | null = null;
let transport: Transport | null = null;
let mockPrinter: MockPrinter | null = null;
let status: Status = "closed";
let mock = false;
/** Set while printing or identifying: the firmware query runs outside the driver's own queue. */
let busy = false;
let paper: {
  paperOut: boolean;
  paperLow: boolean;
  paperJam: boolean;
  coverOpen: boolean;
  ticketAtExit: boolean;
  faults: string[];
} | null = null;

const usbId = [CUSTOM_VENDOR_ID, KPM180H_PRODUCT_ID].map((id) => id.toString(16).padStart(4, "0")).join(":");

export const state = () => ({ status, mock, usbId, busy, paper });

const tell = () => announce("custom", state());

export function configure(options: { mock: boolean }): void {
  // A device opened in one mode must never carry on into the other.
  if (status !== "closed") throw new Error("Disconnect before changing mode");
  mock = options.mock;
  tell();
}

function remember(read: CustomStatus): void {
  const words = (p: typeof paper) => p ? [...p.faults, ...(p.paperLow ? ["paper low"] : [])].join(", ") : undefined;
  const before = words(paper);
  paper = {
    paperOut: read.paperOut,
    paperLow: read.paperLow,
    paperJam: read.paperJam,
    coverOpen: read.coverOpen,
    ticketAtExit: read.ticketAtExit,
    faults: faults(read),
  };
  const now = words(paper);
  // Only changes are logged: the page reads status after every command.
  if (now !== before) log(now ? "warned" : "ok", now ? `Printer reports ${now}` : "Printer ready");
  tell();
}

async function release(): Promise<void> {
  await transport?.close();
  printer = null;
  transport = null;
  mockPrinter = null;
  status = "closed";
  busy = false;
  paper = null;
}

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();
  log("info", mock ? "Opening mock KPM180-H" : `Opening ${usbId} over USB`);
  try {
    if (mock) transport = mockPrinter = new MockPrinter();
    else {
      const usb = new USBTransport(CUSTOM_VENDOR_ID, KPM180H_PRODUCT_ID);
      transport = usb;
      await usb.open();
    }
    printer = new CustomPOS(transport);
    try {
      remember(await printer.waitReady());
    }
    catch (err) {
      throw new Error(`No answer to CUSTOM/POS status (${(err as Error).message}); a unit with AEA firmware answers AEA instead`);
    }
  }
  catch (err) {
    await release().catch(() => {});
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  status = "open";
  tell();
  log("ok", "Printer answered CUSTOM/POS status");
}

export async function disconnect(): Promise<void> {
  if (!printer) return;
  // Nothing to leave dark: CUSTOM/POS has no lights or motors running between commands.
  await release();
  tell();
  log("info", "Printer released");
}

/** Run one exchange with the printer; a lost USB link closes the session. */
async function talk<T>(work: (open: CustomPOS) => Promise<T>): Promise<T> {
  if (!printer) throw new Error("Not connected");
  if (busy) throw new Error("The printer is busy; try again when it has finished");
  try {
    return await work(printer);
  }
  catch (err) {
    if (err instanceof ConnectionLost) {
      await release().catch(() => {});
      tell();
      log("error", `${err.message}. Reconnect to continue.`);
    }
    throw err;
  }
}

/** Mark the printer busy for a multi-step exchange, and announce it. */
async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  busy = true;
  tell();
  try {
    return await work();
  }
  finally {
    if (busy) {
      busy = false;
      tell();
    }
  }
}

export const actions: Record<string, (body: Record<string, unknown>) => unknown> = {
  async status() {
    await talk(async (open) => remember(await open.status()));
  },

  identity() {
    return talk((open) =>
      exclusive(async () => {
        const id = await open.identify();
        // The firmware query writes straight to the transport, which is why the printer is held busy.
        const info = await readFirmwareInfo(transport!);
        const result = {
          model: `0x${id.model.toString(16).padStart(4, "0")}${id.model === MODEL_KPM180H ? " (KPM180H)" : ""}`,
          firmware: id.firmware,
          serialNumber: id.serialNumber,
          autocutter: id.autocutter,
          labelStock: id.labelStock,
          firmwareLines: info?.lines ?? [],
        };
        log("info", `Model ${result.model} · firmware ${id.firmware} · ${info?.model ?? "no firmware-info reply"}`);
        return result;
      })
    );
  },

  /** Print the fixed sample ticket and cut it. */
  async print() {
    await talk((open) =>
      exclusive(async () => {
        log("sent", "Printing the test ticket");
        try {
          remember(await open.printTicket(sampleTicket()));
          log("ok", "Test ticket printed and cut");
        }
        catch (err) {
          // A fault ends the print; read the status back so the page shows why.
          if (!(err instanceof ConnectionLost)) await open.status().then(remember, () => {});
          throw err;
        }
      })
    );
  },

  /** Body: `{ condition }`, one of paper-low, paper-out, jam, clear. Mock only. */
  async simulate({ condition }) {
    if (!mock || !mockPrinter) throw new Error("Only a mock printer has simulated paper");
    if (!["paper-low", "paper-out", "jam", "clear"].includes(condition as string)) {
      throw new Error("condition must be one of paper-low, paper-out, jam, clear");
    }
    mockPrinter.simulate(condition as CustomSimulation);
    await actions.status({});
  },
};

/**
 * The Hitachi-Omron V4KU manual insertion card reader, as one device of the tester.
 *
 * **Cardholder data never leaves this module except in the reply to the read that produced it.**
 * `@eai/omron` returns an unmasked PAN and its own documentation says nothing above it should log
 * the PAN or the raw stripe. This is that "above it": the activity log is told a card was read and
 * how the tracks decoded, never what was on them. Masking for display is the page's job; not
 * recording it is this one's.
 *
 * @module
 */

import type { HidDevice } from "@eai/hid";
import { ALL_TRACKS, LED_COLOR_DIGIT, LED_OFF, LED_ON_PREFIX, OmronV4KU, SHUTTER_COMMANDS, V4KU_PID, V4KU_VID } from "@eai/omron/v4ku";
import type { CardData, LedColor, MonitorOutcome, TransactionSetting } from "@eai/omron/v4ku";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("cardreader", kind, text);

/**
 * What the driver accepts, read from the driver rather than listed here.
 *
 * The light board and the passport reader both do this, and the README says why: nothing in this
 * repo keeps its own list, so it cannot disagree with the driver about what the device has. A
 * colour added to `LED_COLOR_DIGIT` reaches the page without either side being edited.
 */
export const vocabulary = () => ({ ledColors: Object.keys(LED_COLOR_DIGIT) as LedColor[] });

/**
 * The interface the driver claims, from the driver.
 *
 * The passport reader's ids come from the device once its DLL has opened one; this reader's are
 * fixed and known before anything is opened, so they come from `@eai/omron` instead — either way
 * the page is told rather than told to remember.
 */
export const usb = { vendorId: V4KU_VID, productId: V4KU_PID };

// ---------------------------------------------------------------------------------------------
// A fake reader, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

/** What the mock will do the next time the page asks it to read. */
export type NextOutcome = "card" | "timeout" | "unreadable";

/**
 * A fabricated stripe: track 1 running straight into track 2, which is how the device delivers
 * them. The PAN is the standard 4111… test number, so nothing here resembles a real card.
 */
const DEMO_STRIPE = "B4111111111111111^SANDOVAL/MARIA            ^29092010000002590000004111111111111111=29092010000259";

const REPORT_IN = 0x42;
const HEADER = 3;

/**
 * Speaks enough of the V4KU's report protocol to drive the real driver.
 *
 * Command payloads are `C` + a two-character code + parameters; replies are `P`/`N`/`E` + that same
 * code + a two-digit status + any data. Answering with the real codes means the driver's own
 * framing, echo-matching and track parsing are the ones under test, not a second implementation.
 */
class MockReader implements HidDevice {
  // The driver's own ids, so the mock claims to be the device the driver expects rather than a
  // second copy of the same two numbers written out here.
  readonly info = {
    vendorId: V4KU_VID,
    productId: V4KU_PID,
    product: "V4KU (mock)",
    manufacturer: "Hitachi-Omron",
  } as unknown as HidDevice["info"];
  readonly inputReportLength = 64;

  #inbound: Uint8Array[] = [];
  #next: NextOutcome = "card";

  arm(outcome: NextOutcome): void {
    this.#next = outcome;
  }

  #reply(payload: string): void {
    const body = new TextEncoder().encode(payload);
    const report = new Uint8Array(HEADER + body.length);
    report[0] = REPORT_IN;
    report[1] = (body.length >> 8) & 0xff;
    report[2] = body.length & 0xff;
    report.set(body, HEADER);
    this.#inbound.push(report);
  }

  write(report: Uint8Array): Promise<void> {
    const length = (report[1] << 8) | report[2];
    const payload = new TextDecoder().decode(report.subarray(HEADER, HEADER + length));
    // Cancel arrives on its own report ID and carries no command code to echo.
    if (report[0] === 0x01 || payload === "E") return Promise.resolve();

    const code = payload.slice(1, 3);
    switch (code) {
      case "00":
        this.#reply("P0000");
        break;
      case "6s":
        this.#reply("P6s00");
        break;
      case ":6":
        this.#reply("P:600");
        break;
      case "92":
        this.#reply(this.#next === "timeout" ? "N9261" : "P9202");
        break;
      case "6a":
        this.#reply(this.#next === "unreadable" ? "N6a49" : `P6a00${DEMO_STRIPE}`);
        break;
      // The indicator: `CP7<digit>` lights a colour, `CP6` puts it out.
      case "P7":
      case "P6":
      // The shutter: `CC0` locks, `CC1` releases.
      case "C0":
      case "C1":
        this.#reply(`P${code}00`);
        break;
      default:
        // An unknown command still gets an echoing negative, which is what the device does and what
        // the driver's resynchronisation expects to see. Every command the driver can actually send
        // is handled above; reaching this means the driver grew one the mock has not learned.
        this.#reply(`N${code}99`);
    }
    return Promise.resolve();
  }

  read(timeoutMs: number): Promise<Uint8Array | null> {
    const next = this.#inbound.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => setTimeout(() => resolve(null), Math.min(timeoutMs, 40)));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export type Status = "closed" | "opening" | "open";
export type Phase = "idle" | "waiting" | "reading";

let reader: OmronV4KU | null = null;
let mockReader: MockReader | null = null;
let status: Status = "closed";
let phase: Phase = "idle";
let mock = false;
let led: LedColor | "off" = "off";
let seconds = 60;

let transaction: TransactionSetting = {
  direction: "back",
  tracks: ALL_TRACKS,
  insertionLock: false,
  pullOutLock: false,
};

export function configure(options: { mock: boolean }): void {
  mock = options.mock;
}

export const state = () => ({
  status,
  usb,
  vocabulary: vocabulary(),
  phase,
  mock,
  led,
  seconds,
  transaction: { ...transaction },
  /** The literals these settings will put on the wire, so the page can show what it is sending. */
  literals: {
    prepare: `C:6${transaction.direction === "none" ? 0 : transaction.direction === "insertion" ? 1 : 2}` +
      `${transaction.tracks}${transaction.insertionLock ? 1 : 0}${transaction.pullOutLock ? 1 : 0}`,
    monitor: `C92${String(seconds).padStart(2, "0")}`,
    read: `C6a${transaction.tracks}`,
    // Measured against the vendor DLL rather than inferred — see `SHUTTER_COMMANDS`, which had
    // them the wrong way round when they were a guess.
    lock: SHUTTER_COMMANDS.lock.body,
    unlock: SHUTTER_COMMANDS.unlock.body,
    // Built from the driver's own prefix and digit map rather than spelled out: the page was
    // showing a bare `CP7`, which is not a command — the colour digit is the whole parameter.
    led: led === "off" ? LED_OFF.body : LED_ON_PREFIX + LED_COLOR_DIGIT[led],
  },
});

const tell = () => announce("cardreader", state());

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();
  log("info", mock ? "Opening mock reader" : "Opening V4KU over USB HID");

  try {
    if (mock) {
      mockReader = new MockReader();
      reader = await OmronV4KU.openWithDevice(mockReader, { transaction });
    }
    else {
      reader = await OmronV4KU.open({ transaction });
    }
  }
  catch (err) {
    status = "closed";
    reader = null;
    mockReader = null;
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }

  status = "open";
  tell();
  log("ok", "Reader opened");
}

export async function disconnect(): Promise<void> {
  const open = reader;
  if (!open) return;
  reader = null;
  mockReader = null;
  status = "closed";
  phase = "idle";
  led = "off";
  try {
    await open.ledOff();
  }
  catch { /* a reader already unreachable cannot be darkened */ }
  await open.close();
  tell();
  log("info", "Reader released");
}

function held(): OmronV4KU {
  if (!reader) throw new Error("Not connected");
  return reader;
}

export async function reset(): Promise<void> {
  await held().initialReset();
  log("sent", "C00 — initial reset");
}

export async function clearRead(): Promise<void> {
  await held().clearReadData();
  log("sent", "C6s — read buffer cleared");
}

export function settings(next: Partial<TransactionSetting>): void {
  transaction = { ...transaction, ...next };
  tell();
  log("info", `Transaction: ${state().literals.prepare}`);
}

export function monitorSeconds(next: number): void {
  seconds = Math.min(99, Math.max(1, Math.round(next)));
  tell();
}

export async function setLed(color: LedColor | "off"): Promise<void> {
  const open = held();
  if (color === "off") await open.ledOff();
  else await open.setLed(color);
  led = color;
  tell();
  log("sent", `LED ${color}`);
}

/**
 * Hold the card in the throat, or release it.
 *
 * Separate from the transaction's `insertionLock` / `pullOutLock`, which say what the *next* read
 * should do; these drive the shutter now, which is what someone standing at a kiosk with a card
 * stuck in it needs.
 */
export async function shutter(locked: boolean): Promise<void> {
  const open = held();
  if (locked) await open.lock();
  else await open.unlock();
  log("sent", `${locked ? SHUTTER_COMMANDS.lock.body : SHUTTER_COMMANDS.unlock.body} — shutter ${locked ? "locked" : "unlocked"}`);
}

/**
 * What a read produced.
 *
 * `card` is returned to the caller and nothing else. The activity log gets the shape of the result —
 * which tracks decoded — and never the PAN or the stripe.
 */
export interface ReadResult {
  kind: MonitorOutcome["kind"];
  card?: CardData;
  status?: string;
}

export async function read(): Promise<ReadResult> {
  const open = held();
  phase = "waiting";
  tell();
  log("sent", `${state().literals.prepare} · ${state().literals.monitor}`);

  try {
    await open.prepareTransaction(transaction);
    const outcome = await open.readOnce(seconds);

    if (outcome.kind === "card") {
      phase = "idle";
      tell();
      const { track1, track2 } = outcome.card;
      // Which tracks decoded, never what was on them.
      const decoded = [track1 ? "track 1" : null, track2 ? "track 2" : null].filter(Boolean).join(" + ");
      log("ok", `Card read — ${decoded || "no track parsed"}`);
      return { kind: "card", card: outcome.card };
    }

    phase = "idle";
    tell();
    if (outcome.kind === "timeout") log("info", `No card within ${seconds}s`);
    else if (outcome.kind === "cancelled") log("info", "Read cancelled");
    else log("error", `Card present but unreadable (${outcome.status})`);
    return { kind: outcome.kind, status: outcome.kind === "readFailed" ? outcome.status : undefined };
  }
  catch (err) {
    phase = "idle";
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export async function cancel(): Promise<void> {
  await held().cancel();
  phase = "idle";
  tell();
  log("info", "Cancel sent");
}

/** Arm what the mock reader will do next. The page offers this only when mocking. */
export function arm(outcome: NextOutcome): void {
  if (!mock || !mockReader) throw new Error("Only a mock reader can be armed");
  mockReader.arm(outcome);
  log("info", `Mock armed: ${outcome}`);
}

/**
 * The Sankyo ICM330 manual insertion card reader, as one device of the tester.
 *
 * The same cardholder rule as the V4K applies: `@eai/sankyo` returns an unmasked PAN, and this
 * module tells the activity log only that a card was read and which tracks decoded. A card leaves
 * here in the reply to the read that produced it, or once through {@link takeCard}, and nowhere
 * else.
 *
 * @module
 */

import type { MessageTransport } from "@eai/models";
import {
  CANCEL,
  ICM330_PRODUCT_ID,
  ICM330_VENDOR_ID,
  ICM330CancelledError,
  ICM330CommandError,
  ICM330Monitor,
  ICM330Reader,
  LED_COLOR_DIGIT,
  openICM330,
  packetize,
} from "@eai/sankyo";
import type { CardData, LedColor, ReaderStatus } from "@eai/sankyo";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("sankyo", kind, text);

// ---------------------------------------------------------------------------------------------
// A fake reader, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

/** Fabricated tracks, without sentinels as the reader sends them. The PAN is the 4111… test number. */
const DEMO_TRACKS = [
  "B4111111111111111^SANDOVAL/MARIA            ^2909201000000259000000",
  "4111111111111111=29092010000259",
];

/**
 * Speaks enough of the ICM330's report protocol to drive the real driver: a two-byte length and
 * `C` + cm pm + data, answered with `P`/`N` + cm pm + a two-character code + data, in 63-byte
 * packets. The card is moved from the page, so the monitor's polling sees it arrive and leave the
 * way it would on a kiosk.
 */
class MockICM330 implements MessageTransport {
  isOpen = true;
  #inbound: Uint8Array[] = [];
  #wake: (() => void) | null = null;
  #inserted = false;
  /** Which tracks the read buffer holds. */
  #buffer: [boolean, boolean] = [false, false];
  /** An Intake waiting for a card, answered by {@link insert}, its timer, or a cancel. */
  #intake: { timer: ReturnType<typeof setTimeout> } | null = null;

  get inserted(): boolean {
    return this.#inserted;
  }

  /** A card goes fully in, and the insertion read fills the buffer. */
  insert(): void {
    this.#inserted = true;
    this.#buffer = [true, true];
    if (this.#intake) {
      clearTimeout(this.#intake.timer);
      this.#intake = null;
      this.#reply(`P11${this.#status()}`);
    }
  }

  remove(): void {
    this.#inserted = false;
  }

  /** st1 st0: the low bits carry front/rear sensors and the tracks held. */
  #status(): string {
    const st1 = this.#inserted ? 0x03 : 0;
    const st0 = (this.#buffer[0] ? 1 : 0) | (this.#buffer[1] ? 2 : 0);
    return String.fromCharCode(0x30 | st1, 0x30 | st0);
  }

  #reply(text: string | Uint8Array): void {
    const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
    this.#inbound.push(...packetize(bytes));
    this.#wake?.();
  }

  send(packet: Uint8Array): void {
    const length = (packet[0] << 8) | packet[1];
    const text = packet.subarray(2, 2 + length);
    if (text.length === 2 && text[0] === CANCEL[0] && text[1] === CANCEL[1]) {
      if (this.#intake) clearTimeout(this.#intake.timer);
      this.#intake = null;
      this.#reply(CANCEL);
      return;
    }

    const body = new TextDecoder().decode(text);
    const command = body.slice(1, 3);
    switch (command) {
      case "0@":
        this.#reply("P0@00MOCKTYPECODE01");
        break;
      case "10":
        this.#reply(`P10${this.#status()}`);
        break;
      case "11": {
        if (this.#inserted) {
          this.#reply(`P11${this.#status()}`);
          break;
        }
        const ms = Number(body.slice(3, 11));
        this.#intake = { timer: setTimeout(() => (this.#intake = null, this.#reply("N1109")), ms) };
        break;
      }
      case "21":
      case "22": {
        const track = Number(command[1]) - 1;
        this.#reply(this.#buffer[track] ? `P${command}00${DEMO_TRACKS[track]}` : `P${command}00`);
        break;
      }
      case "23":
        // Track 3 is never written on the demo card; the reader reports a missing stripe.
        this.#reply("N2323");
        break;
      case "26":
        this.#buffer = [false, false];
        this.#reply("P2600");
        break;
      case "41":
        this.#reply("P4100ICM330-MOCK");
        break;
      case "42":
        this.#reply("P4200MOCK00000001");
        break;
      case "A1":
        this.#reply("PA100MOCK-1.00");
        break;
      default:
        // The LED is `C3` + a colour digit; every other command gets an echoing refusal.
        this.#reply(command[0] === "3" ? `P${command}00` : `N${command}99`);
    }
  }

  async receive(signal?: AbortSignal): Promise<Uint8Array | null> {
    while (this.isOpen && !signal?.aborted) {
      const next = this.#inbound.shift();
      if (next) return next;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      this.#wake = null;
    }
    return null;
  }

  close(): void {
    if (this.#intake) clearTimeout(this.#intake.timer);
    this.isOpen = false;
    this.#wake?.();
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export type Status = "closed" | "opening" | "open";

let reader: ICM330Reader | null = null;
let mockReader: MockICM330 | null = null;
let monitor: ICM330Monitor | null = null;
let status: Status = "closed";
let reading = false;
let mock = false;
let led: LedColor = "off";
let seconds = 30;
/** Whether a card is in the slot, as the monitor last saw it. Only known while listening. */
let present = false;
/** A card a listening session read, held for collection for the same reason as the V4K's. */
let waiting: CardData | null = null;

const usbId = [ICM330_VENDOR_ID, ICM330_PRODUCT_ID].map((id) => id.toString(16).padStart(4, "0")).join(":");

export function configure(options: { mock: boolean }): void {
  // A device opened in one mode must never carry on into the other.
  if (status !== "closed") throw new Error("Disconnect before changing mode");
  mock = options.mock;
  tell();
}

export const state = () => ({
  status,
  mock,
  usbId,
  reading,
  listening: monitor !== null,
  present,
  mockInserted: mockReader?.inserted ?? false,
  cardWaiting: waiting !== null,
  led,
  /** The bezel's colours, from the driver's own vocabulary. `off` is one of them. */
  ledColors: Object.keys(LED_COLOR_DIGIT) as LedColor[],
  seconds,
});

const tell = () => announce("sankyo", state());

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();
  log("info", mock ? "Opening mock ICM330" : `Opening ${usbId} over USB HID`);

  try {
    if (mock) {
      mockReader = new MockICM330();
      reader = ICM330Reader.withTransport(mockReader);
      await reader.initialize();
    }
    else {
      reader = await openICM330();
    }
  }
  catch (err) {
    await reader?.close().catch(() => {});
    status = "closed";
    reader = null;
    mockReader = null;
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }

  status = "open";
  tell();
  log("ok", "Reader initialized");
}

export async function disconnect(): Promise<void> {
  const open = reader;
  if (!open) return;
  reader = null;
  status = "closed";
  await monitor?.stop();
  monitor = null;
  present = false;
  waiting = null;
  try {
    await open.cancel();
    await open.led("off");
  }
  catch { /* a reader already unreachable cannot be darkened */ }
  await open.close();
  mockReader = null;
  led = "off";
  tell();
  log("info", "Reader released");
}

function held(): ICM330Reader {
  if (!reader) throw new Error("Not connected");
  return reader;
}

/** Which tracks decoded, never what was on them. */
function decoded(card: CardData): string {
  const parsed = [card.track1?.fields ? "track 1" : null, card.track2?.fields ? "track 2" : null].filter(Boolean);
  return parsed.join(" + ") || "no track parsed";
}

export function monitorSeconds(next: number): void {
  seconds = Math.min(99, Math.max(1, Math.round(next)));
  tell();
}

export async function setLed(color: LedColor, blink: boolean): Promise<void> {
  if (!(color in LED_COLOR_DIGIT)) throw new Error(`'${color}' is not a colour the reader has`);
  await held().led(color, blink && color !== "off" ? "1s" : undefined);
  led = color;
  tell();
  log("sent", `LED ${color}${blink && color !== "off" ? " blinking" : ""}`);
}

export interface ReadResult {
  kind: "card" | "timeout" | "cancelled";
  card?: CardData;
}

/** Wait for a card to go in, then read every track the reader holds for it. */
export async function read(): Promise<ReadResult> {
  const open = held();
  if (monitor) throw new Error("Stop listening first");
  reading = true;
  tell();
  log("sent", `Intake · ${seconds}s`);
  try {
    // A previous card's data would otherwise pass for this one.
    await open.clearReadBuffer();
    let intake: ReaderStatus | undefined;
    try {
      intake = await open.intake(seconds * 1000);
    }
    catch (err) {
      // `08`: the card stopped short of the rear, but a track was read on the way in. Read it.
      if (!(err instanceof ICM330CommandError && err.code === "08")) throw err;
      log("warned", "Card stopped short of the rear; reading what it gave up");
    }
    const card = await open.readCard(intake);
    log("ok", `Card read — ${decoded(card)}`);
    return { kind: "card", card };
  }
  catch (err) {
    if (err instanceof ICM330CancelledError) {
      log("info", "Read cancelled");
      return { kind: "cancelled" };
    }
    // `09`: the Intake timer ran out with no card.
    if (err instanceof ICM330CommandError && err.code === "09") {
      log("info", `No card within ${seconds}s`);
      return { kind: "timeout" };
    }
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  finally {
    reading = false;
    tell();
  }
}

export async function cancel(): Promise<void> {
  await held().cancel();
  log("info", "Cancel sent");
}

/** Poll for cards through the driver's monitor until {@link stopListening}. */
export async function startListening(): Promise<void> {
  const open = held();
  if (monitor || reading) return;
  const started = new ICM330Monitor(open);
  started.on("present", () => {
    present = true;
    log("info", "Card in");
    tell();
  });
  started.on("absent", () => {
    present = false;
    log("info", "Card out");
    tell();
  });
  started.on("card", (card: CardData) => {
    waiting = card;
    log("ok", `Card read — ${decoded(card)}`);
    tell();
  });
  started.on("error", (err: Error) => log("error", err.message));
  started.on("lost", () => {
    monitor = null;
    log("error", "The reader stopped answering. Reconnect to continue.");
    tell();
  });
  waiting = null;
  // Held only once polling is under way: a start that fails must not leave the page "listening".
  await started.start();
  monitor = started;
  tell();
  log("info", "Listening");
}

export async function stopListening(): Promise<void> {
  const stopping = monitor;
  monitor = null;
  present = false;
  await stopping?.stop();
  tell();
  log("info", "Stopped listening");
}

export function takeCard(): CardData | null {
  const card = waiting;
  waiting = null;
  if (card) tell();
  return card;
}

export async function identity(): Promise<{ deviceName: string; serialNumber: string; revision: string }> {
  const open = held();
  const deviceName = await open.deviceName();
  const serialNumber = await open.serialNumber();
  const revision = await open.revision();
  log("info", `${deviceName} · serial ${serialNumber} · firmware ${revision}`);
  return { deviceName, serialNumber, revision };
}

/** Put the mock card in the slot, or take it out. The page offers this only when mocking. */
export function simulateCard(inserted: boolean): void {
  if (!mock || !mockReader) throw new Error("Only a mock reader has a simulated card");
  if (inserted) mockReader.insert();
  else mockReader.remove();
  tell();
  log("info", `Mock card ${inserted ? "inserted" : "removed"}`);
}

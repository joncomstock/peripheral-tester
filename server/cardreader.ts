/**
 * The Hitachi-Omron V4K manual insertion card reader, as one device of the tester.
 *
 * **Cardholder data never leaves this module except in the reply to the read that produced it.**
 * `@eai/omron-v4k` returns an unmasked PAN, and nothing above it should log the PAN or the raw
 * stripe. This is that "above it": the activity log is told a card was read and how the tracks
 * decoded, never what was on them. Masking for display is the page's job; not recording it is this
 * one's.
 *
 * @module
 */

import type { MessageTransport } from "@eai/models";
import {
  DEFAULT_TRANSACTION,
  LED_COLOR_DIGIT,
  monitorCardStatus,
  OmronV4K,
  openV4K,
  prepareTransaction,
  readMagTrack,
  trackDigit,
  V4K_PRODUCT_ID,
  V4K_VENDOR_ID,
  V4KCancelledError,
  V4KCommandError,
} from "@eai/omron-v4k";
import type { CardData, LedColor, LedControlMode, ReadOutcome, TransactionSetting } from "@eai/omron-v4k";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("cardreader", kind, text);

// ---------------------------------------------------------------------------------------------
// A fake reader, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

/** What the mock will do the next time the page asks it to read. */
export type NextOutcome = "card" | "timeout" | "unreadable";

/**
 * Fabricated tracks. The PAN is the standard 4111… test number, so nothing here resembles a real
 * card.
 */
const DEMO_TRACKS: Record<number, string> = {
  1: "B4111111111111111^SANDOVAL/MARIA            ^2909201000000259000000",
  2: "4111111111111111=29092010000259",
  4: "",
};

/**
 * Speaks enough of the V4K's message protocol to drive the real driver.
 *
 * Messages are a two-byte length and an ASCII body. Commands are `C` + a two-character code +
 * parameters; replies are `P`/`N` + that code + a two-digit status + any data, and a cancel (`E`)
 * is echoed. Answering with the real codes means the driver's own framing, echo matching and track
 * parsing are the ones under test, not a second implementation.
 */
class MockReader implements MessageTransport {
  isOpen = true;
  #inbound: Uint8Array[] = [];
  #wake: (() => void) | null = null;
  /** One-shot, like the page says: after it is used the reader waits for a card that never comes. */
  #next: NextOutcome | null = "card";
  /** A monitor waiting out its window, answered with a timeout unless cancelled first. */
  #parked: ReturnType<typeof setTimeout> | undefined;

  arm(outcome: NextOutcome): void {
    this.#next = outcome;
    // A monitor already waiting answers now, the way a card arriving mid-wait would end it.
    if (this.#parked !== undefined) {
      clearTimeout(this.#parked);
      this.#parked = undefined;
      this.#monitor(0);
    }
  }

  /** Answer a `C92` monitor from what is armed, or park it for its window when nothing is. */
  #monitor(seconds: number): void {
    const next = this.#next;
    if (next === null) {
      this.#parked = setTimeout(() => {
        this.#parked = undefined;
        this.#reply("N9261");
      }, seconds * 1000);
      return;
    }
    // An unreadable card still arrives; it is the track read that fails.
    if (next !== "unreadable") this.#next = null;
    this.#reply(next === "timeout" ? "N9261" : "P9202");
  }

  #reply(body: string): void {
    const bytes = new TextEncoder().encode(body);
    const message = new Uint8Array(2 + bytes.length);
    message[0] = (bytes.length >> 8) & 0xff;
    message[1] = bytes.length & 0xff;
    message.set(bytes, 2);
    this.#inbound.push(message);
    this.#wake?.();
  }

  send(message: Uint8Array): void {
    const length = (message[0] << 8) | message[1];
    const body = new TextDecoder().decode(message.subarray(2, 2 + length));
    if (body === "E") {
      clearTimeout(this.#parked);
      this.#parked = undefined;
      this.#reply("E");
      return;
    }

    const code = body.slice(1, 3);
    const param = body.slice(3);
    switch (code) {
      case "92":
        this.#monitor(Number(param));
        break;
      // Media status: a card sits in the slot while one is armed to be read.
      case "11":
        this.#reply(this.#next === "card" || this.#next === "unreadable" ? "P1102" : "P1100");
        break;
      case "6a": {
        // Read on its own (a listen cycle, with no monitor before it), the card is used up here.
        if (this.#next === "card") this.#next = null;
        if (this.#next === "unreadable") {
          this.#next = null;
          this.#reply("N6a40");
          break;
        }
        const tracks = [1, 2, 3, 4, 5, 6, 7].find((mask) => trackDigit(mask) === param) ?? 0;
        const order = [1, 2, 4].filter((bit) => (tracks & bit) !== 0);
        const statuses = order.map(() => "00").join("");
        const lengths = order.map((bit) => String(DEMO_TRACKS[bit].length).padStart(3, "0")).join("");
        this.#reply(`P6a00${param}${statuses}${lengths}${order.map((bit) => DEMO_TRACKS[bit]).join("")}`);
        break;
      }
      // The read-only enquiries answer with a payload, not just a status.
      case "V0":
        this.#reply("PV000V4KU-MOCK-1.00");
        break;
      case "UE":
        this.#reply("PUE00MOCK00000001");
        break;
      case "N0":
        this.#reply("PN0000000");
        break;
      // Reset, clear, transaction, the LED commands and the LED mode: plain acknowledgements.
      case "00":
      case "6s":
      case ":6":
      case "P6":
      case "P7":
      case "P8":
      case "N3":
        this.#reply(`P${code}00`);
        break;
      default:
        // An unknown command still gets an echoing negative, which is what the device does. Every
        // command the driver can send is handled above; reaching this means it grew a new one.
        this.#reply(`N${code}99`);
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
    clearTimeout(this.#parked);
    this.isOpen = false;
    this.#wake?.();
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export type Status = "closed" | "opening" | "open";
export type Phase = "idle" | "waiting" | "reading";

let reader: OmronV4K | null = null;
let mockReader: MockReader | null = null;
let status: Status = "closed";
let phase: Phase = "idle";
let mock = false;
let led: LedColor | "off" = "off";
let seconds = 60;
let listening = false;
/** Whether a card is in the slot, as the listen loop last polled. Only known while listening. */
let present = false;
/** The listen loop in flight, so stopping can wait for it to actually let go of the line. */
let loop: Promise<void> | null = null;
/**
 * Who drives the bezel LED.
 *
 * The device does not report this. It matters because in `automatic` the reader drives its own LED,
 * so `setLed` is competing with it — which looks exactly like a broken indicator.
 */
let ledMode: LedControlMode = "manual";
/** Steady or blinking. The device does not report this either. */
let ledBlinking = false;
/**
 * A card a listening session read, waiting to be collected.
 *
 * Held here rather than pushed. The event stream is shared by every connected client, so putting
 * cardholder data on it would broadcast one operator's card to every open tab; the stream carries
 * only that a card is waiting, and whoever wants it fetches it once through {@link takeCard}.
 */
let waiting: CardData | null = null;

let transaction: TransactionSetting = DEFAULT_TRANSACTION;

export function configure(options: { mock: boolean }): void {
  // A device opened in one mode must never carry on into the other.
  if (status !== "closed") throw new Error("Disconnect before changing mode");
  mock = options.mock;
  tell();
}

/** The USB identity the driver opens, as `lsusb` and Device Manager show it. */
const usbId = [V4K_VENDOR_ID, V4K_PRODUCT_ID].map((id) => id.toString(16).padStart(4, "0")).join(":");

export const state = () => ({
  status,
  phase,
  mock,
  usbId,
  led,
  ledBlinking,
  listening,
  present,
  cardWaiting: waiting !== null,
  /** The bezel's colours, from the driver's own vocabulary. */
  ledColors: Object.keys(LED_COLOR_DIGIT),
  ledMode,
  seconds,
  transaction: { ...transaction },
  /** The literals these settings will put on the wire, built by the driver's own command builders. */
  literals: {
    prepare: prepareTransaction(transaction).body,
    monitor: monitorCardStatus(seconds).body,
    read: readMagTrack(transaction.tracks).body,
  },
});

const tell = () => announce("cardreader", state());

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();
  log("info", mock ? "Opening mock reader" : `Opening ${usbId} over USB HID`);

  try {
    if (mock) {
      mockReader = new MockReader();
      reader = OmronV4K.withTransport(mockReader, { transaction });
      await reader.initialize();
    }
    else {
      reader = await openV4K({ transaction });
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
  ledBlinking = false;
  ledMode = "manual";
  waiting = null;
  try {
    // A parked monitor holds the line; it has to let go before the LED command can be heard.
    await endListening(open);
    await open.ledOff();
  }
  catch { /* a reader already unreachable cannot be darkened */ }
  await open.close();
  tell();
  log("info", "Reader released");
}

function held(): OmronV4K {
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

export async function settings(next: Partial<TransactionSetting>): Promise<void> {
  const proposed = { ...transaction, ...next };
  // The reader holds the setting, so it is applied as it changes rather than at the next read.
  if (reader) await reader.applyTransaction(proposed);
  transaction = proposed;
  tell();
  log("info", `Transaction: ${state().literals.prepare}`);
}

export function monitorSeconds(next: number): void {
  seconds = Math.min(99, Math.max(1, Math.round(next)));
  tell();
}

export async function setLed(color: LedColor | "off", blink?: boolean): Promise<void> {
  const open = held();
  // Automatic mode means the reader is driving the LED; asking for a colour while it does would look
  // like the command was ignored, so control comes back first.
  if (ledMode === "automatic") await setLedMode("manual");
  if (color === "off") await open.ledOff();
  else if (blink) await open.ledBlink(color, "1hz");
  else await open.ledOn(color);
  led = color;
  ledBlinking = color !== "off" && blink === true;
  tell();
  log("sent", `LED ${color}${ledBlinking ? " blinking" : ""}`);
}

/** Which tracks decoded, never what was on them. */
function decoded(card: CardData | null): string {
  const parsed = [card?.track1?.fields ? "track 1" : null, card?.track2?.fields ? "track 2" : null].filter(Boolean);
  return parsed.join(" + ") || "no track parsed";
}

/**
 * What a read produced.
 *
 * `card` is returned to the caller and nothing else. The activity log gets the shape of the result —
 * which tracks decoded — and never the PAN or the stripe.
 */
export interface ReadResult {
  kind: "card" | "timeout" | "cancelled" | "readFailed";
  card?: CardData;
  status?: string;
}

/** One read, with the driver's refusals turned into outcomes. */
async function cycle(readCard: () => Promise<ReadOutcome>): Promise<ReadResult> {
  try {
    const outcome = await readCard();
    if (outcome.outcome === "timeout") return { kind: "timeout" };
    if (!outcome.card) return { kind: "readFailed", status: outcome.response.status };
    return { kind: "card", card: outcome.card };
  }
  catch (err) {
    if (err instanceof V4KCancelledError) return { kind: "cancelled" };
    if (err instanceof V4KCommandError) return { kind: "readFailed", status: err.response.status };
    throw err;
  }
}

export async function read(): Promise<ReadResult> {
  const open = held();
  if (listening) throw new Error("Stop listening first");
  phase = "waiting";
  tell();
  log("sent", `${state().literals.prepare} · ${state().literals.monitor}`);

  try {
    const result = await cycle(() => open.readCard(seconds));
    if (result.kind === "card") log("ok", `Card read — ${decoded(result.card ?? null)}`);
    else if (result.kind === "timeout") log("info", `No card within ${seconds}s`);
    else if (result.kind === "cancelled") log("info", "Read cancelled");
    else log("error", `Card present but unreadable (${result.status})`);
    return result;
  }
  catch (err) {
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  finally {
    phase = "idle";
    tell();
  }
}

export async function cancel(): Promise<void> {
  await held().cancel();
  phase = "idle";
  tell();
  log("info", "Cancel sent");
}

/**
 * Hand the bezel LED to the reader, or take it back.
 *
 * In `automatic` the reader lights its own LED from what it is doing, and {@link setLed} is then
 * fighting it — the symptom is an indicator that appears not to respond. Setting a colour therefore
 * takes control back first rather than leaving the operator to work that out.
 */
export async function setLedMode(mode: LedControlMode): Promise<void> {
  await held().setLedControlMode(mode);
  ledMode = mode;
  tell();
  log("sent", `CN3${mode === "manual" ? 0 : 1} — LED control ${mode}`);
}

/**
 * Read cards continuously until {@link stopListening}.
 *
 * Mirrors the driver's own monitor (`OmronV4KLifecycle.startMonitoring`), which is tied to hotplug
 * and so cannot wrap the mock: poll card presence, and read a card the moment it arrives with
 * `readInsertedCard`, once per card. A full `readCard` cycle per card would spend its preamble while
 * a quick dip is already coming back out, and lose it. A card is kept for collection rather than
 * pushed onward, for the reason on {@link waiting}; the stream is told only that one is there.
 */
export function startListening(): void {
  const open = held();
  if (listening) return;
  listening = true;
  waiting = null;
  tell();
  log("info", "Listening — polling for a card");

  // Not awaited: the loop runs until stopped, and the caller wants an answer now.
  loop = (async () => {
    let ready = true;
    while (listening && reader === open) {
      const presence = await open.cardPresence();
      // "unknown" is the reader not answering with a media state; it neither arms nor reads.
      if (presence !== "unknown") {
        const now = presence !== "not-present";
        if (now !== present) {
          present = now;
          log("info", now ? "Card in" : "Card out");
          tell();
        }
        if (!now) ready = true;
        else if (ready) {
          ready = false;
          const result = await cycle(() => open.readInsertedCard(seconds));
          if (result.kind === "card") {
            waiting = result.card ?? null;
            log("ok", `Card read — ${decoded(waiting)}`);
            tell();
          }
          else if (result.kind === "timeout") log("info", `Card not withdrawn within ${seconds}s`);
          else if (result.kind === "readFailed") log("error", `Card present but unreadable (${result.status})`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })().catch((err: Error) => {
    // A stop cancels whatever the loop was waiting on; that is the stop working, not a fault.
    if (listening) log("error", err.message);
    listening = false;
    tell();
  }).finally(() => {
    present = false;
  });
}

/**
 * Stop the listen loop and wait until it has let go of the line.
 *
 * One cancel is not enough: sent between two commands, it is swallowed by the next one's drain, and
 * a read that follows can hold the line for its whole window. So it is repeated until the loop ends.
 */
async function endListening(open: OmronV4K): Promise<void> {
  listening = false;
  const running = loop;
  loop = null;
  if (!running) return;
  let ended = false;
  let cancelled = false;
  running.finally(() => (ended = true));
  while (true) {
    // An idle loop sees the flag at its next poll; only a read in flight needs cancelling.
    await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 400))]);
    if (ended) break;
    await open.cancel();
    cancelled = true;
  }
  // A cancel that lands after the loop's last command is still echoed, and the driver would take that
  // echo as cancelling the next command. Spend it on a harmless one.
  if (cancelled) await open.clearReadData().catch(() => {});
}

export async function stopListening(): Promise<void> {
  await endListening(held());
  tell();
  log("info", "Stopped listening");
}

/**
 * Collect the card a listening session read, clearing it.
 *
 * Single-shot on purpose: the card leaves this process once, to whoever asked, and is gone. Nothing
 * keeps a copy and nothing re-serves it.
 */
export function takeCard(): CardData | null {
  const card = waiting;
  waiting = null;
  if (card) tell();
  return card;
}

/** The device's own identity and status. Read-only enquiries. */
export async function identity(): Promise<{ version: string; serialNumber: string; status: string }> {
  const open = held();
  const version = await open.version();
  const serialNumber = await open.serialNumber();
  const deviceStatus = await open.deviceStatus();
  log("info", `Version ${version} · serial ${serialNumber} · status ${deviceStatus}`);
  return { version, serialNumber, status: deviceStatus };
}

/** Arm what the mock reader will do next. The page offers this only when mocking. */
export function arm(outcome: NextOutcome): void {
  if (!mock || !mockReader) throw new Error("Only a mock reader can be armed");
  mockReader.arm(outcome);
  log("info", `Mock armed: ${outcome}`);
}

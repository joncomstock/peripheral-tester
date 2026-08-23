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
import { ALL_TRACKS, CANDIDATE_LITERALS, OmronV4KU } from "@eai/omron/v4ku";
import type { CardData, LedColor, LedControlMode, MonitorOutcome, TransactionSetting } from "@eai/omron/v4ku";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("cardreader", kind, text);

// ---------------------------------------------------------------------------------------------
// A fake reader, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

/** What the mock will do the next time the page asks it to read. */
export type NextOutcome = "card" | "timeout" | "unreadable";

/**
 * Whether the shutter is holding a card.
 *
 * The device does not report this, so it is what was last commanded. On real hardware the card in
 * the slot is the authority — this is here so the page can show which way it last asked.
 */
export type Shutter = "locked" | "unlocked";

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
  readonly info = {
    vendorId: 0x0590,
    productId: 0x0034,
    product: "V4KU (mock)",
    manufacturer: "Hitachi-Omron",
  } as unknown as HidDevice["info"];
  readonly inputReportLength = 64;

  #inbound: Uint8Array[] = [];
  #next: NextOutcome = "card";
  #shutter: Shutter = "unlocked";

  get shutter(): Shutter {
    return this.#shutter;
  }

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
      // The indicator: `CP7<digit>` lights a colour, `CP8<digit><digit>` blinks it, `CP6` puts it out.
      case "P7":
      case "P8":
      case "P6":
        this.#reply(`P${code}00`);
        break;
      // Who drives the bezel LED: `CN3` + mode digit.
      case "N3":
        this.#reply("PN300");
        break;
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
      // IC contacts down.
      case "C6":
        this.#reply("PC600");
        break;
      // The shutter: `CC0` holds a card, `CC1` releases it.
      case "C0":
      case "C1":
        this.#shutter = code === "C0" ? "locked" : "unlocked";
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
let shutter: Shutter = "unlocked";
let listening = false;
/**
 * Who drives the bezel LED.
 *
 * The device does not report this either. It matters because in `automatic` the reader drives its
 * own LED, so `setLed` is competing with it — which looks exactly like a broken indicator.
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
  phase,
  mock,
  led,
  ledBlinking,
  listening,
  cardWaiting: waiting !== null,
  candidates: CANDIDATE_LITERALS,
  ledMode,
  shutter,
  seconds,
  transaction: { ...transaction },
  /** The literals these settings will put on the wire, so the page can show what it is sending. */
  literals: {
    prepare: `C:6${transaction.direction === "none" ? 0 : transaction.direction === "insertion" ? 1 : 2}` +
      `${transaction.tracks}${transaction.insertionLock ? 1 : 0}${transaction.pullOutLock ? 1 : 0}`,
    monitor: `C92${String(seconds).padStart(2, "0")}`,
    read: `C6a${transaction.tracks}`,
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
  ledBlinking = false;
  shutter = "unlocked";
  ledMode = "manual";
  listening = false;
  waiting = null;
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

export async function setLed(color: LedColor | "off", blink?: boolean): Promise<void> {
  const open = held();
  // Automatic mode means the reader is driving the LED; asking for a colour while it does would look
  // like the command was ignored, so control comes back first.
  if (ledMode === "automatic") await setLedMode("manual");
  if (color === "off") await open.ledOff();
  else if (blink) await open.blinkLed(color);
  else await open.setLed(color);
  led = color;
  ledBlinking = color !== "off" && blink === true;
  tell();
  log("sent", `LED ${color}${ledBlinking ? " blinking" : ""}`);
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
 * Hold a card in the reader, or let it go.
 *
 * `CC0` locks the shutter and `CC1` releases it — measured from the vendor DLL, and the pair was
 * documented backwards once, which would have made locking *open* on a captured card. Releasing is
 * therefore never gated on believing the shutter is currently held: if the tester's idea of the
 * state is wrong, the way out still has to work.
 */
export async function setShutter(next: Shutter): Promise<void> {
  const open = held();
  if (next === "locked") await open.lock();
  else await open.unlock();
  shutter = next;
  tell();
  log(next === "locked" ? "warned" : "ok", next === "locked" ? "CC0 — shutter locked, card held" : "CC1 — shutter released");
}

/**
 * Read cards continuously until {@link stopListening}.
 *
 * The driver emits one event per cycle. A card is kept for collection rather than pushed onward, for
 * the reason on {@link waiting}; the stream is told only that one is there.
 */
export function startListening(): void {
  const open = held();
  if (listening) return;
  listening = true;
  waiting = null;
  tell();
  log("info", `Listening — ${state().literals.monitor} per cycle`);

  open.on("card", (card: CardData) => {
    waiting = card;
    const decoded = [card.track1 ? "track 1" : null, card.track2 ? "track 2" : null].filter(Boolean).join(" + ");
    log("ok", `Card read — ${decoded || "no track parsed"}`);
    tell();
  });
  open.on("timeout", () => log("info", "Cycle elapsed with no card"));
  open.on("readFailed", (status: string) => log("error", `Card present but unreadable (${status})`));

  // Not awaited: the loop runs until stopped, and the caller wants an answer now.
  open.listen().catch((err: Error) => {
    listening = false;
    tell();
    log("error", err.message);
  });
}

export async function stopListening(): Promise<void> {
  const open = held();
  listening = false;
  await open.stop();
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
  const version = await open.getVersion();
  const serialNumber = await open.getSerialNumber();
  const status = await open.getStatus();
  log("info", `Version ${version} · serial ${serialNumber} · status ${status}`);
  return { version, serialNumber, status };
}

export async function deactivateIcc(): Promise<void> {
  await held().deactivateIcc();
  log("sent", "CC6 — IC contacts down");
}

/**
 * Send one unidentified literal and report what came back.
 *
 * Restricted to the driver's own candidate list. That list exists because the device's command space
 * also holds firmware download, tamper and rear-destroy operations, and issuing one of those can do
 * something neither read-only nor undoable — so this takes a choice from a vetted set rather than
 * free text. It reports whether the device accepted the command; it cannot say what the command
 * *did*, which is what watching the hardware is for.
 */
export async function probe(literal: string): Promise<{ literal: string; token: string; accepted: boolean }> {
  const open = held();
  if (!CANDIDATE_LITERALS.includes(literal)) {
    throw new Error(`'${literal}' is not in the driver's candidate list`);
  }
  const response = await open.sendRaw(literal);
  const accepted = response.outcome === "positive";
  log(accepted ? "warned" : "info", `${literal} → ${response.token}${accepted ? " — accepted, watch the device" : ""}`);
  return { literal, token: response.token, accepted };
}

/** Arm what the mock reader will do next. The page offers this only when mocking. */
export function arm(outcome: NextOutcome): void {
  if (!mock || !mockReader) throw new Error("Only a mock reader can be armed");
  mockReader.arm(outcome);
  log("info", `Mock armed: ${outcome}`);
}

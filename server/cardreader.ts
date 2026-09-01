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
import { listenForWarnings } from "./driverWarnings.ts";
import {
  DEFAULT_CLEAR_READ_DELAY_MS,
  DEFAULT_TRACK_READ_DELAY_MS,
  OmronV4KU,
  TRACK_1,
  TRACK_2,
  TRACK_3,
  V4KU_PID,
  V4KU_VID,
} from "@eai/omron/v4ku";
import type { CardData, LedColor, MonitorOutcome, ReadDirection, TransactionSetting } from "@eai/omron/v4ku";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("cardreader", kind, text);

/**
 * What the driver accepts.
 *
 * This used to read the keys off the driver's own colour-to-digit map, the way the light board and
 * the passport reader still read theirs. `@eai/omron` has since narrowed to a capability surface —
 * the wire prefixes and digit maps are deliberately internal, so that a protocol correction is not
 * a breaking change — and there is no map left to read.
 *
 * So the colours are written out, but as `Record<LedColor, true>` rather than an array: a colour
 * added to the driver's `LedColor` fails to compile here instead of quietly going missing from the
 * page. `main.ts` guards its own vocabularies the same way and for the same reason.
 */
const LED_COLORS: Record<LedColor, true> = { green: true, red: true, orange: true };

export const vocabulary = () => ({ ledColors: Object.keys(LED_COLORS) as LedColor[] });

/**
 * Track bitmask to the digit the wire takes. **These are not the same number.**
 *
 * Mirrored from `@eai/omron`'s own `TRACK_WIRE_DIGIT`, which is internal to the driver by design —
 * the package keeps its digit maps unpublished so a protocol correction is not a breaking change.
 * The API side is a bitmask (1/2/4); the wire side enumerates the seven usable combinations 1..7 in
 * order, three singles then three pairs then all three. They coincide only for track 1 alone and
 * for all three, which is exactly why building the chip from the bitmask looked correct: the
 * default asked for all three, one of the two values that agree.
 *
 * Display only, like everything else in {@link WIRE} — the driver builds the real command. A
 * driver-side correction leaves this stale, which shows a wrong label rather than sending a wrong
 * command.
 *
 * Its keys are computed bitmask values, so it takes an annotation where the maps in {@link WIRE}
 * take `satisfies`. Both are checked; neither is an assertion.
 */
const TRACK_WIRE_DIGIT: Readonly<Record<number, string>> = {
  [TRACK_1]: "1",
  [TRACK_2]: "2",
  [TRACK_3]: "3",
  [TRACK_1 | TRACK_2]: "4",
  [TRACK_1 | TRACK_3]: "5",
  [TRACK_2 | TRACK_3]: "6",
  [TRACK_1 | TRACK_2 | TRACK_3]: "7",
};

/**
 * Wire literals, mirrored from the driver for display only.
 *
 * Nothing here is ever sent: the driver builds every command itself, and these exist so the page
 * can show what a setting will put on the wire. They were imported until the driver stopped
 * publishing them. A driver-side correction now leaves this copy stale, which shows the page a
 * wrong label rather than sending a wrong command — the shutter pair is the one to watch. `CC0`
 * locks and `CC1` releases, measured off the vendor DLL after being the wrong way round for as
 * long as they were a guess.
 */
const WIRE = {
  ledOn: "CP7",
  ledOff: "CP6",
  ledDigit: { green: "1", red: "2", orange: "3" } satisfies Record<
    LedColor,
    string
  >,
  lock: "CC0",
  unlock: "CC1",
  direction: { none: "0", insertion: "1", back: "2" } satisfies Record<
    ReadDirection,
    string
  >,
  /** See {@link TRACK_WIRE_DIGIT} — the bitmask and the wire digit are not the same number. */
  trackDigit: TRACK_WIRE_DIGIT,
} as const;

// Reply-header literals, mirrored from `@eai/omron`'s `track.ts` for the same reason as `WIRE`.

/** A track's two-digit status in the reply header. Zero is a clean read; anything else is a failure. */
const TRACK_STATUS_OK = 0;

/** The wire digit for a mask, or `?` for one the device has no digit for — never a wrong digit. */
const trackDigit = (tracks: number): string => WIRE.trackDigit[tracks] ?? "?";

/** How many ISO tracks a mask asks for. */
const trackCount = (tracks: number): number => [TRACK_1, TRACK_2, TRACK_3].filter((bit) => (tracks & bit) !== 0).length;

/**
 * A track-read reply, in a form the activity log may carry.
 *
 * The reply is a five-character token, then a fixed header — the echoed mask, a two-digit status
 * per track and a three-digit length per track — then the tracks themselves. The header is device
 * metadata and says whether a stripe was decoded at all, which is the whole question a failed read
 * raises. Everything after it is cardholder data and never leaves this function.
 *
 * **Leading digits are not proof of a header.** The wire digit for tracks 1 and 2 is `4` and a Visa
 * PAN starts with `4`, so a reply that carried track 2 with no header at all would clear a
 * digits-only test and put the first eleven digits of a card number on the page. Three further
 * checks stand in the way, each mirrored from `@eai/omron`'s own `classifyReply`:
 *
 * - the mask must echo what was asked for — the driver's "byte 0 is knowable in advance";
 * - the lengths must account for the payload **exactly**. At most is not enough, and this is the
 *   check that was wrong: `4000000000000002=29092010000259` read as a header declares `000/000`
 *   out of its own digits and leaves twenty bytes unaccounted for. An at-most test waves that
 *   through and prints `mask 4, status 00/00, length 000/000` — the card's first eleven digits,
 *   in order, in the activity log. The driver carries the same rule and a regression test for it:
 *   "bytes unaccounted for mean the field widths are not what we think";
 * - a track's status and its length must agree: one that failed to read carried no bytes, and a
 *   header declaring nothing at all cannot have a body;
 * - a declared track 1 holding track 2's separator is not a track 1. This is what catches a
 *   zero-heavy Visa BIN that *does* add up exactly — `4000002000012345=…` declares `020/000`, fits
 *   the payload, and is caught here instead.
 *
 * **No ISO length floor, deliberately.** The driver refuses to *slice* a track shorter than its own
 * mandatory fields, and mirroring that rule here looked right. It is wrong for a function whose job
 * is to report: a partially-read stripe declares exactly such a length — `length 008/000` against
 * status `00/49` — and that reading is the entire diagnostic an intermittently-failing reader is
 * being debugged with. A floor hides the evidence at the one moment it is wanted. It is also not
 * what closes the leak: 400,000 synthetic track-2 stripes were checked without it, and none was
 * believed.
 *
 * These are a copy, with the usual ceiling: a driver-side correction leaves them stale. Stale here
 * fails closed — an unbelieved header is reported as a byte count and nothing else.
 */
export function describeTrackReply(
  token: string,
  data: string,
  tracksRequested: number,
): string {
  const size = `${token} — ${data.length} bytes`;
  if (data.length === 0) return `${size}, no payload`;

  const count = trackCount(tracksRequested);
  const width = 1 + count * 5;
  const header = data.slice(0, width);
  // The slice is short when the payload is, so the anchored test covers both.
  const shaped = new RegExp(`^\\d{${width}}$`).test(header) &&
    header[0] === trackDigit(tracksRequested);
  if (!shaped) return `${size}, payload not in header shape`;

  // Unpacked onto the track each field belongs to, not the slot it arrived in: under a
  // `TRACK_2 | TRACK_3` request slot 0 is track 2, and a floor applied by slot would be track 1's.
  const fields: { track: number; status: string; length: string }[] = [];
  let slot = 0;
  for (const track of [TRACK_1, TRACK_2, TRACK_3]) {
    if ((tracksRequested & track) === 0) continue;
    fields.push({
      track,
      status: header.slice(1 + slot * 2, 3 + slot * 2),
      length: header.slice(1 + count * 2 + slot * 3, 4 + count * 2 + slot * 3),
    });
    slot++;
  }

  const declared = fields.reduce(
    (total, field) => total + Number(field.length),
    0,
  );
  const body = data.length - width;

  // A track that failed to read has no bytes, and a header declaring nothing cannot have a body.
  const contradictsItself = fields.some((field) => Number(field.status) !== TRACK_STATUS_OK && Number(field.length) > 0) ||
    (declared === 0 && body > 0);
  // Neither readable track read: a header and nothing else, which is the reply this whole function
  // exists to report. It is believed without a length budget because there is no body to budget.
  const readable = fields.filter((field) => field.track !== TRACK_3);
  const noReadableTrackRead = readable.length > 0 &&
    readable.every((field) => Number(field.status) !== TRACK_STATUS_OK);
  // A declared track 1 holding track 2's separator is not a track 1. The zero-heavy `40000x` Visa
  // BINs need this: they read as a header that adds up exactly, and the length it carries then
  // carves the card in two. The slice is cardholder data and, like everything here, stays inside.
  const trackOne = fields.find((field) => field.track === TRACK_1);
  const declaredTrackOneIsOne = trackOne === undefined ||
    Number(trackOne.length) === 0 ||
    !data.slice(width, width + Number(trackOne.length)).includes("=");

  const believable = !contradictsItself && declaredTrackOneIsOne &&
    (noReadableTrackRead || (declared > 0 && declared === body));
  if (!believable) return `${size}, payload not in header shape`;

  const joined = (pick: (field: typeof fields[number]) => string) => fields.map(pick).join("/");
  return `${size}, mask ${header[0]}, status ${joined((f) => f.status)}, length ${joined((f) => f.length)}`;
}

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
 * A fabricated card: track 1 running straight into track 2, which is how the device delivers them.
 * The PAN is the standard 4111… test number, so nothing here resembles a real card.
 *
 * Kept as two tracks rather than one blob because the reply's header declares a length per track,
 * and a mock that cannot say how long each one is cannot build a header the driver would believe.
 */
const DEMO_TRACKS: Readonly<Record<number, string>> = {
  [TRACK_1]: "B4111111111111111^SANDOVAL/MARIA            ^2909201000000259000000",
  [TRACK_2]: "4111111111111111=29092010000259",
  [TRACK_3]: "",
};

/** Which ISO tracks a wire digit asks for — the mock's half of {@link WIRE.trackDigit}. */
const WIRE_DIGIT_TRACKS: Readonly<Record<string, readonly number[]>> = {
  "1": [TRACK_1],
  "2": [TRACK_2],
  "3": [TRACK_3],
  "4": [TRACK_1, TRACK_2],
  "5": [TRACK_1, TRACK_3],
  "6": [TRACK_2, TRACK_3],
  "7": [TRACK_1, TRACK_2, TRACK_3],
};

/**
 * A track-read reply in the shape the device sends one: the token, then the echoed mask, a
 * two-digit status per track and a three-digit length per track, then the tracks themselves.
 *
 * The header is not decoration. It is what the driver's parser and {@link describeTrackReply} check
 * a reply against, so a mock that omits it drives only the unframed fallback and never the path a
 * real device takes — which is how the header could be got wrong here and still look right in mock.
 */
function trackReadReply(
  token: string,
  wireDigit: string,
  tracks: readonly string[],
): string {
  const status = tracks.map((track) => (track === "" ? "49" : "00")).join("");
  const lengths = tracks.map((track) => String(track.length).padStart(3, "0"))
    .join("");
  return token + wireDigit + status + lengths + tracks.join("");
}

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
      case "6a": {
        // The device echoes the mask it was asked for, so the reply is built from what arrived
        // rather than from the shipped default: a page that narrows the tracks narrows the header.
        const wireDigit = payload.slice(3, 4);
        const asked = WIRE_DIGIT_TRACKS[wireDigit] ?? [TRACK_1, TRACK_2];
        const unreadable = this.#next === "unreadable";
        const tracks = asked.map((
          track,
        ) => (unreadable ? "" : DEMO_TRACKS[track] ?? ""));
        this.#reply(
          trackReadReply(unreadable ? "N6a49" : "P6a00", wireDigit, tracks),
        );
        break;
      }
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

/**
 * The driver's own `DEFAULT_TRANSACTION`, restated because the driver does not publish it.
 *
 * Tracks 1 and 2 rather than all three, for the reason `@eai/omron`'s defaults give: a payment card
 * generally carries no track 3, and asking for a track the card does not have fails the whole read.
 * This shipped as `ALL_TRACKS`, so a fresh connect started in a configuration that cannot read an
 * ordinary card — it reported `card present but unreadable` with every track answering status 49.
 */
let transaction: TransactionSetting = {
  direction: "back",
  tracks: TRACK_1 | TRACK_2,
  insertionLock: false,
  pullOutLock: false,
};

/**
 * The two carried-over read delays, taken from the driver rather than restated.
 *
 * Unlike {@link transaction}, these cannot be changed on a live reader: they are `readonly` on
 * `OmronV4KU` and set in its constructor, deliberately, because a delay that changed mid-cycle would
 * mean one read that used two different values. Changing them here therefore only decides what the
 * *next* open uses — see {@link reopen}.
 */
let delays = {
  trackReadDelayMs: DEFAULT_TRACK_READ_DELAY_MS,
  clearReadDelayMs: DEFAULT_CLEAR_READ_DELAY_MS,
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
  /** What the next open will use. `pending` says the live reader was opened with something else. */
  delays: {
    ...delays,
    // Answered by the reader rather than by a copy of what was asked for: these are `readonly` on
    // the instance, so what it reports is what it is actually applying between the tracks.
    pending: reader !== null &&
      (reader.trackReadDelayMs !== delays.trackReadDelayMs || reader.clearReadDelayMs !== delays.clearReadDelayMs),
    /**
     * The driver's own defaults, so the page can offer "back to shipped" without writing the two
     * numbers down where they would be free to disagree with `@eai/omron`.
     */
    shipped: { trackReadDelayMs: DEFAULT_TRACK_READ_DELAY_MS, clearReadDelayMs: DEFAULT_CLEAR_READ_DELAY_MS },
  },
  /** The literals these settings will put on the wire, so the page can show what it is sending. */
  literals: {
    prepare: `C:6${WIRE.direction[transaction.direction]}${trackDigit(transaction.tracks)}` +
      `${transaction.insertionLock ? 1 : 0}${transaction.pullOutLock ? 1 : 0}`,
    monitor: `C92${String(seconds).padStart(2, "0")}`,
    read: `C6a${trackDigit(transaction.tracks)}`,
    lock: WIRE.lock,
    unlock: WIRE.unlock,
    // The colour digit is the whole parameter: the page was showing a bare `CP7`, which is not a
    // command.
    led: led === "off" ? WIRE.ledOff : WIRE.ledOn + WIRE.ledDigit[led],
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
      reader = await OmronV4KU.openWithDevice(mockReader, { transaction, ...delays });
    }
    else {
      reader = await OmronV4KU.open({ transaction, ...delays });
    }
    listenForWarnings("cardreader", loggerName());
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

/**
 * Close the reader and open it again on the current delays.
 *
 * Explicit, and never automatic on a delay change. `disconnect()` darkens the LED and drops the
 * handle but does not release the shutter, so a reopen while a card is retained leaves that card in
 * the throat — which is not something to do behind someone's back while they are running cards.
 */
export async function reopen(): Promise<void> {
  log("info", `Reopening on track ${delays.trackReadDelayMs}ms, clear ${delays.clearReadDelayMs}ms`);
  await disconnect();
  await connect();
}

function held(): OmronV4KU {
  if (!reader) throw new Error("Not connected");
  return reader;
}

/** The name `@eai/omron` logs under — `OmronV4KU:` and the identity, hex, four digits each. */
const loggerName = () => `OmronV4KU:${V4KU_VID.toString(16).padStart(4, "0")}:${V4KU_PID.toString(16).padStart(4, "0")}`;

/**
 * One read cycle driven as three raw commands, reporting the device's replies rather than a verdict.
 *
 * `readOnce` answers "did a card read", which is the right answer for a kiosk and the wrong one at
 * a bench: a reply the driver declines to use and a reply the device refused both arrive as
 * `readFailed`, and the reply itself is gone. This issues the same three literals through the
 * published escape hatch and reports what came back, so a failing read can be attributed to the
 * device or to the driver's reading of it.
 *
 * It is not a substitute for `Read once`. The driver holds one lock across monitor and track read
 * so nothing can disturb the buffered card between them; three `sendRaw` calls take that lock three
 * times. With one person at a bench that is safe, and it is the only way to see the reply.
 */
export async function diagnosticRead(): Promise<void> {
  const open = held();
  const { prepare, read } = state().literals;
  // Comfortably inside the driver's 30s acknowledgement budget, which `sendRaw` waits for — the
  // configured monitor window can be 60s and would time the command out rather than the card wait.
  const wait = 25;
  const monitor = `C92${String(wait).padStart(2, "0")}`;

  log("info", `Diagnostic read — C6s, ${prepare}, ${monitor}, ${read}`);
  /*
   * `readOnce` runs `#prepareForRead` first — cancel and drain, clear the read buffer, apply the
   * transaction — and this ran only the third. The same literals read a card here and failed with
   * status 49 there, so the preamble is what stands between them.
   *
   * Only the clear is replicated. The cancel is not, and cannot honestly be: `#cancelAndDrain`
   * cancels *and consumes the reply the cancel produces*, holding the lock across both, while the
   * public `cancel()` deliberately does neither — it exists to interrupt a parked monitor, which
   * consumes the reply for it. Calling the public one here with nothing in flight left that reply
   * in the pipe and the next command matched nothing for thirty seconds. So this isolates the one
   * step it can: if the read now fails, `C6s` is what costs it; if it survives, the cancel is.
   */
  const cleared = await open.sendRaw("C6s");
  log(
    cleared.outcome === "positive" ? "sent" : "error",
    `C6s → ${cleared.token}`,
  );
  // The allowance the driver makes after clearing, so this is not faster than the real path.
  await new Promise((resume) => setTimeout(resume, 200));

  const prepared = await open.sendRaw(prepare);
  log(
    prepared.outcome === "positive" ? "sent" : "error",
    `${prepare} → ${prepared.token}`,
  );
  if (prepared.outcome !== "positive") return;

  // The same phase a real read reports. Without it the diagnostic waited fifteen seconds behind a
  // lamp that still said Idle, which reads as a dead button — and gets clicked again.
  phase = "waiting";
  tell();
  log("info", `Insert the card now — waiting ${wait}s`);
  const monitored = await open.sendRaw(monitor);
  phase = "idle";
  tell();
  log(
    monitored.outcome === "positive" ? "sent" : "info",
    `${monitor} → ${monitored.token}`,
  );
  if (monitored.outcome !== "positive") return;

  // The same allowance `readOnce` makes before collecting the tracks. Without it this diagnostic
  // could fail where the ordinary read succeeds, which would send us after the wrong fault.
  await new Promise((resume) => setTimeout(resume, 500));
  const collected = await open.sendRaw(read);
  log(
    collected.outcome === "positive" && collected.status === "00" ? "ok" : "warned",
    describeTrackReply(collected.token, collected.data, transaction.tracks),
  );
}

/**
 * Send one identified literal and log the device's own verdict.
 *
 * `initialReset()` and `clearReadData()` were methods on the driver and are now internal: the
 * reader issues both itself, as part of opening and of each read cycle, and no longer offers them
 * as operations. `sendRaw` is the published escape hatch, and both literals are ones the driver's
 * own `IDENTIFIED_LITERALS` names, so neither is a guess.
 *
 * `sendRaw` returns a refusal rather than throwing — "the device rejected this" is an answer, not
 * a failure — so a negative is logged as an error here rather than vanishing into a resolved
 * promise.
 */
async function raw(body: string, what: string): Promise<void> {
  const reply = await held().sendRaw(body);
  const ok = reply.outcome === "positive";
  log(
    ok ? "sent" : "error",
    `${body} — ${what}${ok ? "" : ` refused (${reply.token})`}`,
  );
}

export const reset = (): Promise<void> => raw("C00", "initial reset");

export const clearRead = (): Promise<void> => raw("C6s", "read buffer cleared");

export function settings(next: Partial<TransactionSetting>): void {
  transaction = { ...transaction, ...next };
  tell();
  log("info", `Transaction: ${state().literals.prepare}`);
}

/**
 * Set what the next open will use for the two read delays.
 *
 * Clamped here rather than left to the driver: `OmronV4KU` validates these in its constructor and
 * throws, which on this path would mean a reopen that fails and leaves the bench with no reader.
 */
export function readDelays(next: Partial<typeof delays>): void {
  const whole = (value: number) => Math.max(0, Math.round(value));
  if (next.trackReadDelayMs !== undefined) delays.trackReadDelayMs = whole(next.trackReadDelayMs);
  if (next.clearReadDelayMs !== undefined) delays.clearReadDelayMs = whole(next.clearReadDelayMs);
  tell();
  log("info", `Read delays: track ${delays.trackReadDelayMs}ms, clear ${delays.clearReadDelayMs}ms — on the next open`);
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
  log(
    "sent",
    `${locked ? WIRE.lock : WIRE.unlock} — shutter ${locked ? "locked" : "unlocked"}`,
  );
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
    // Adopt, do not apply. `readOnce` applies the transaction as part of every cycle, so sending
    // it here too put `C:6…` on the wire twice — and the device answered the monitor `P9200`
    // rather than `P9202`, detecting the card without reading it, with the track read then
    // returning status 49 on both tracks and zero length. That was every failed read on this
    // bench; the identical sequence with one `C:6…` reads the card.
    open.adopt(transaction);
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
    return {
      kind: outcome.kind,
      status: outcome.kind === "readFailed" ? outcome.status : undefined,
    };
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

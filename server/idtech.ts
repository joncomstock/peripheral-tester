/**
 * The ID TECH Secure Mag Insert (MOIR family) card reader, as one device of the tester.
 *
 * The same cardholder rule as the V4K applies: `@eai/idtech` returns an unmasked PAN, and this
 * module tells the activity log only that a card was read and which tracks decoded. A card leaves
 * here in the reply to the read that produced it, or once through `take-card`, and nowhere else.
 *
 * Nothing is armed per card on this reader: it reads the stripe as the card is withdrawn and
 * reports it unasked, along with the slot switches as the card moves. So a "read" here waits for
 * the next card the reader reports, and a card nobody is reading or listening for is dropped.
 * Writing the reader's settings, LED control and reset are left out: the driver does not offer
 * them (they are unconfirmed on this unit), and the first two change how the reader behaves for
 * whatever uses it next.
 *
 * @module
 */

import {
  ACK,
  encodeCommand,
  GET_SETTING,
  GET_STATUS,
  GET_VERSION,
  IDTECH_PRODUCT_ID,
  IDTECH_VENDOR_ID,
  IdTechReader,
  NAK,
  openIdTech,
  SERIAL_NUMBER_ID,
  STATUS_UNKNOWN_COMMAND,
} from "@eai/idtech";
import type { CardData, IdTechTransport, ReaderStatus } from "@eai/idtech";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("idtech", kind, text);

// ---------------------------------------------------------------------------------------------
// A fake reader, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

/** What the mock card carries. */
export type MockCard = "card" | "unreadable";

/** Fabricated tracks. The PAN is the standard 4111… test number, so nothing here resembles a real card. */
const DEMO_TRACKS = [
  "%B4111111111111111^SANDOVAL/MARIA            ^2909201000000259000000?",
  ";4111111111111111=29092010000259?",
];
/** How the reader prints a track it could not decode. */
const UNREADABLE_TRACKS = ["%E?", ";E?"];

/** Slot switches: present (0x08), and seated (0x02) with it. */
const SLOT = { empty: 0x00, present: 0x08, seated: 0x0a } as const;

const IDLE = Uint8Array.of(NAK, 0, 0, 0, 0, 0, 0, 0);

/**
 * Speaks enough of the reader's HID protocol to drive the real driver. Commands arrive as TLP-224
 * frames cut into 8-byte feature reports; the reply is served back the same way, then the idle
 * answer the real unit gives between replies. Input reports (580 bytes: a 7-byte track header, a
 * big-endian output length, the output) carry the slot notifications and card data unasked.
 */
class MockIdTech implements IdTechTransport {
  isOpen = true;
  #pending = new Uint8Array(0);
  #reply: Uint8Array[] = [];
  #input: Uint8Array[] = [];
  #wake: (() => void) | null = null;
  #slot: number = SLOT.empty;

  /** A card goes in, seats, and is withdrawn; the reader reads it on the way out. */
  dip(card: MockCard): void {
    const tracks = card === "card" ? DEMO_TRACKS : UNREADABLE_TRACKS;
    const failed = card === "card" ? 0 : 1;
    this.#notify(SLOT.present);
    this.#notify(SLOT.seated);
    this.#notify(SLOT.present);
    const output = new TextEncoder().encode(tracks.map((track) => track + "\r").join(""));
    this.#push([failed, failed, 0, tracks[0].length + 1, tracks[1].length, 0, 3], output);
    this.#notify(SLOT.empty);
  }

  #notify(status: number): void {
    this.#slot = status;
    this.#push([0, 0, 0, 0, 0, 0, 4], encodeCommand([0xb0, status]));
  }

  #push(header: number[], output: Uint8Array): void {
    const report = new Uint8Array(580);
    report.set(header);
    report[7] = output.length >> 8;
    report[8] = output.length & 0xff;
    report.set(output, 9);
    this.#input.push(report);
    this.#wake?.();
  }

  #answer(command: Uint8Array): Uint8Array {
    const ack = encodeCommand;
    const text = (value: string) => [...new TextEncoder().encode(value)];
    if (command[0] === GET_VERSION[0]) return ack(text("ID TECH MOCK Secure Mag Insert USB HID Reader V0.00"));
    if (command[0] === GET_STATUS[0]) return ack([this.#slot]);
    if (command[0] === GET_SETTING && command[1] === SERIAL_NUMBER_ID) return ack([SERIAL_NUMBER_ID, 9, 8, ...text("MOCK0001")]);
    const nak = encodeCommand([STATUS_UNKNOWN_COMMAND >> 8, STATUS_UNKNOWN_COMMAND & 0xff]);
    nak[0] = NAK;
    nak[nak.length - 2] ^= ACK ^ NAK; // the marker is inside the LRC
    return nak;
  }

  sendFeatureReport(_reportId: number, data: Uint8Array): Promise<void> {
    if (!this.isOpen) return Promise.reject(new Error("HID device is not open"));
    const pending = new Uint8Array(this.#pending.length + data.length);
    pending.set(this.#pending);
    pending.set(data, this.#pending.length);
    const length = ((pending[1] << 8) | pending[2]) + 5;
    if (pending.length < length) {
      this.#pending = pending;
      return Promise.resolve();
    }
    this.#pending = new Uint8Array(0);
    const reply = this.#answer(pending.subarray(3, length - 2));
    this.#reply = [];
    for (let offset = 0; offset < reply.length; offset += 8) {
      const chunk = new Uint8Array(8);
      chunk.set(reply.subarray(offset, offset + 8));
      this.#reply.push(chunk);
    }
    return Promise.resolve();
  }

  receiveFeatureReport(_reportId: number, _length: number): Promise<Uint8Array> {
    if (!this.isOpen) return Promise.reject(new Error("HID device is not open"));
    return Promise.resolve(this.#reply.shift() ?? IDLE.slice());
  }

  send(): Promise<void> {
    return Promise.reject(new Error("the reader declares no output reports"));
  }

  async receive(): Promise<Uint8Array | null> {
    while (this.isOpen) {
      const next = this.#input.shift();
      if (next) return next;
      await new Promise<void>((resolve) => (this.#wake = resolve));
      this.#wake = null;
    }
    return null;
  }

  close(): void {
    this.isOpen = false;
    this.#wake?.();
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export type Status = "closed" | "opening" | "open";

/** The card in the shape the page's card panel takes: tracks with their raw text and ISO fields. */
export interface Card {
  track1?: { raw: string; fields?: { pan: string; name: string; expiry: string } };
  track2?: { raw: string; fields?: { pan: string; expiry: string } };
  track3?: { raw: string };
}

export interface ReadResult {
  kind: "card" | "timeout" | "cancelled" | "readFailed";
  card?: Card;
}

/** How long a read waits for a card. */
const READ_SECONDS = 30;

let reader: IdTechReader | null = null;
let mockReader: MockIdTech | null = null;
let status: Status = "closed";
let mock = false;
/** The slot switches, from the last notification or status read. Null until one arrives. */
let slot: { present: boolean; seated: boolean } | null = null;
let listening = false;
/** A read waiting for the next card, and how to end it. */
let pending: ((result: ReadResult) => void) | null = null;
/**
 * A card a listening session read, waiting to be collected. Held here rather than pushed: the event
 * stream is shared by every open tab, so it carries only that a card is waiting.
 */
let waiting: Card | null = null;

const usbId = [IDTECH_VENDOR_ID, IDTECH_PRODUCT_ID].map((id) => id.toString(16).padStart(4, "0")).join(":");

export const state = () => ({
  status,
  mock,
  usbId,
  slot,
  reading: pending !== null,
  listening,
  cardWaiting: waiting !== null,
  seconds: READ_SECONDS,
});

const tell = () => announce("idtech", state());

export function configure(options: { mock: boolean }): void {
  // A device opened in one mode must never carry on into the other.
  if (status !== "closed") throw new Error("Disconnect before changing mode");
  mock = options.mock;
  tell();
}

/** Only what the panel shows. The driver's `body` repeats the whole stripe and is left behind. */
function shape(card: CardData): Card {
  const [t1, t2] = [card.track1?.fields, card.track2?.fields];
  return {
    track1: card.track1 && { raw: card.track1.raw, fields: t1 && { pan: t1.pan, name: t1.name, expiry: t1.expiry } },
    track2: card.track2 && { raw: card.track2.raw, fields: t2 && { pan: t2.pan, expiry: t2.expiry } },
    track3: card.track3 && { raw: card.track3.raw },
  };
}

/** Which tracks decoded, never what was on them. */
function decoded(card: CardData): string {
  const parsed = [card.track1?.fields ? "track 1" : null, card.track2?.fields ? "track 2" : null].filter(Boolean);
  return parsed.join(" + ") || "no track parsed";
}

const showSlot = (s: ReaderStatus) => ({ present: s.cardPresent, seated: s.cardSeated });

function wire(opened: IdTechReader): void {
  opened.on("status", (next: ReaderStatus) => {
    const was = slot;
    slot = showSlot(next);
    if (was?.present !== slot.present) log("info", slot.present ? "Card in" : "Card out");
    tell();
  });
  opened.on("card", (card: CardData) => {
    // A track the reader could not decode still arrives, with ok false; no good track is a failed read.
    const readable = [card.track1, card.track2, card.track3].some((track) => track?.ok);
    if (!readable) log("error", "Card read, but no track decoded");
    else log("ok", `Card read — ${decoded(card)}`);
    if (pending) pending(readable ? { kind: "card", card: shape(card) } : { kind: "readFailed" });
    else if (listening && readable) {
      waiting = shape(card);
      tell();
    }
    else if (!listening) log("info", "Nobody was reading or listening; the card was not kept");
  });
  opened.on("lost", () => {
    if (reader !== opened) return;
    pending?.({ kind: "cancelled" });
    reader = null;
    mockReader = null;
    status = "closed";
    slot = null;
    listening = false;
    waiting = null;
    tell();
    log("error", "The reader stopped reporting. Reconnect to continue.");
  });
}

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();
  log("info", mock ? "Opening mock ID TECH reader" : `Opening ${usbId} over USB HID`);
  try {
    if (mock) {
      mockReader = new MockIdTech();
      reader = IdTechReader.withTransport(mockReader);
    }
    else {
      reader = await openIdTech();
    }
    wire(reader);
    slot = showSlot(await reader.status());
  }
  catch (err) {
    await reader?.close().catch(() => {});
    reader = null;
    mockReader = null;
    slot = null;
    status = "closed";
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  status = "open";
  tell();
  log("ok", "Reader answered");
}

export async function disconnect(): Promise<void> {
  const open = reader;
  if (!open) return;
  reader = null;
  status = "closed";
  pending?.({ kind: "cancelled" });
  listening = false;
  waiting = null;
  slot = null;
  // Nothing to darken: the driver has no LED control.
  await open.close();
  mockReader = null;
  tell();
  log("info", "Reader released");
}

function held(): IdTechReader {
  if (!reader) throw new Error("Not connected");
  return reader;
}

/** Wait for the next card the reader reports, up to {@link READ_SECONDS}. */
function read(): Promise<ReadResult> {
  held();
  if (listening) throw new Error("Stop listening first");
  if (pending) throw new Error("A read is already waiting");
  log("info", `Waiting ${READ_SECONDS}s for a card`);
  return new Promise<ReadResult>((resolve) => {
    const timer = setTimeout(() => pending?.({ kind: "timeout" }), READ_SECONDS * 1000);
    pending = (result) => {
      clearTimeout(timer);
      pending = null;
      tell();
      if (result.kind === "timeout") log("info", `No card within ${READ_SECONDS}s`);
      else if (result.kind === "cancelled") log("info", "Read cancelled");
      resolve(result);
    };
    tell();
  });
}

export const actions: Record<string, (body: Record<string, unknown>) => unknown> = {
  /** The reply carries the card, the only place it goes. */
  read,

  cancel: () => {
    held();
    pending?.({ kind: "cancelled" });
  },

  /** Keep every card the reader reports, one at a time, for `take-card` to collect. */
  listen: () => {
    held();
    if (pending) throw new Error("Cancel the read first");
    if (listening) return;
    listening = true;
    waiting = null;
    tell();
    log("info", "Listening for cards");
  },

  stop: () => {
    held();
    listening = false;
    waiting = null;
    tell();
    log("info", "Stopped listening");
  },

  /** Single-shot on purpose: the card leaves this process once, to whoever asked, and is gone. */
  "take-card": () => {
    const card = waiting;
    waiting = null;
    if (card) tell();
    return { card };
  },

  /** Firmware version, serial number and the slot as the reader reports it now. Read-only enquiries. */
  identity: async () => {
    const open = held();
    const version = await open.version();
    const serialNumber = await open.serialNumber();
    const now = await open.status();
    slot = showSlot(now);
    tell();
    const where = now.cardSeated ? "card seated" : now.cardPresent ? "card in slot" : "slot empty";
    log("info", `Version ${version} · serial ${serialNumber} · ${where}`);
    return { version, serialNumber, status: where };
  },

  /** Dip a card in the mock reader. The page offers this only when mocking. */
  simulate: (body) => {
    if (!mock || !mockReader) throw new Error("Only a mock reader has a simulated card");
    if (body.card !== "card" && body.card !== "unreadable") throw new Error(`'${body.card}' is not a mock card`);
    mockReader.dip(body.card);
  },
};

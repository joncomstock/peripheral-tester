/**
 * The Storm EZ-Access Nav-Pad, as one device of the tester: the 919's ADA navigation keypad.
 *
 * Two channels on one USB device. The vendor HID channel carries the framed command protocol: the
 * status (firmware, serial, key table), the light, the beeper. The keyboard interface carries the
 * presses, and the driver seizes it so the OS sees none of them — which is how the kiosk app must
 * read them. A capture that cannot be opened fails the connect, as the driver's own lifecycle does:
 * a keypad whose presses go to the OS is not connected in any useful sense. On macOS that means
 * Input Monitoring for the process; on Windows, interface 0 rebound to WinUSB.
 *
 * The headset jack arrives as pseudo-keys the driver debounces into a settled inserted/removed
 * state. The C-Media sound card beside the keypad is a plain audio device the OS drives; not ours.
 *
 * Left out on purpose: `save` (persists settings across power cycles), `reset` (restores
 * defaults), `setSerialNumber` (rewrites the unit), and the key table, whose change would need the
 * capture reopened with the new codes. `setBuzzer` is out too: its range is unverified.
 *
 * @module
 */

import type { MessageTransport } from "@eai/models";
import {
  ACK,
  decodeReply,
  encodeCommand,
  MAX_LED_LEVEL,
  MSG_GET_STATUS,
  MSG_SET_JACK_LED,
  MSG_SET_KEYPRESS_BEEP,
  MSG_SET_LED,
  NAV_PAD_DEFAULT_KEYCODES,
  NAV_PAD_KEY_SLOTS,
  NAV_PAD_PRODUCT_ID,
  type NavPadJackEvent,
  type NavPadKeyEvent,
  type NavPadStatus,
  STORM_REPORTS,
  STORM_USAGE_PAGE,
  STORM_VENDOR_ID,
  StormNavPad,
  StormNavPadKeys,
} from "@eai/storm";
import { HIDTransport } from "@eai/hid";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("storm", kind, text);

/** The eight physical keys: the slots after them are the jack's pseudo-keys. */
const KEYS = NAV_PAD_KEY_SLOTS.slice(0, 8);
const usageOf = (key: string) => NAV_PAD_DEFAULT_KEYCODES[NAV_PAD_KEY_SLOTS.indexOf(key as never)];

// ---------------------------------------------------------------------------------------------
// A fake keypad, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

/** A `MessageTransport` whose `receive()` parks until something is queued or it closes. */
class Queue implements MessageTransport {
  #queue: Uint8Array[] = [];
  #wake: (() => void) | null = null;
  #open = true;

  get isOpen(): boolean {
    return this.#open;
  }

  push(payload: Uint8Array): void {
    this.#queue.push(payload);
    this.#wake?.();
  }

  send(_message: Uint8Array): Promise<void> {
    return Promise.resolve();
  }

  async receive(signal?: AbortSignal): Promise<Uint8Array | null> {
    while (this.#open && !signal?.aborted) {
      const queued = this.#queue.shift();
      if (queued) return queued;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      this.#wake = null;
    }
    return null;
  }

  close(): Promise<void> {
    this.#open = false;
    this.#wake?.();
    return Promise.resolve();
  }
}

/**
 * The vendor channel: answers each command with the ACK and then an echo frame, as the unit does,
 * and builds the status frame from what it was last told. Replies ride the same frame format as
 * commands, so the driver's encoder builds them and its decoder reads the commands.
 */
class MockCommands extends Queue {
  #led = 9;
  #jackLed = 0;
  #beep = true;

  override send(message: Uint8Array): Promise<void> {
    const command = decodeReply(message);
    if (command === null || command === "ack") return Promise.resolve();
    const [value] = command.data;
    if (command.msgId === MSG_SET_LED) this.#led = value;
    if (command.msgId === MSG_SET_JACK_LED) this.#jackLed = value;
    if (command.msgId === MSG_SET_KEYPRESS_BEEP) this.#beep = value !== 0;
    this.push(new Uint8Array([1, ACK]));
    this.push(encodeCommand(command.msgId, command.msgId === MSG_GET_STATUS ? this.#status() : [0]));
    return Promise.resolve();
  }

  /** The layout of a live V4.0 status: result, LEDs, beep, "8 key", period, table, keycodes, ids. */
  #status(): Uint8Array {
    const data = new Uint8Array(47);
    data.set([0, this.#led, this.#jackLed, this.#beep ? 1 : 0, 2, 1, 0]);
    NAV_PAD_DEFAULT_KEYCODES.forEach((usage, slot) => data.set([usage >> 8, usage & 0xff], 7 + slot * 2));
    data.set(new TextEncoder().encode("V4.0"), 27);
    data.set(new TextEncoder().encode("MOCK00000001"), 34);
    return data;
  }
}

/** The keyboard interface: 8-byte boot reports listing the usages held down. */
class MockKeyboard extends Queue {
  #held = new Set<number>();
  #timers = new Set<ReturnType<typeof setTimeout>>();

  #report(): void {
    this.push(new Uint8Array([0, 0, ...[...this.#held, 0, 0, 0, 0, 0, 0].slice(0, 6)]));
  }

  /** A press held long enough for the page to show it down, then released. */
  press(usage: number): void {
    this.#held.add(usage);
    this.#report();
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.#held.delete(usage);
      this.#report();
    }, 250);
    this.#timers.add(timer);
  }

  /** The keypad types a jack change as a pseudo-key, pressed and released at once. */
  tap(usage: number): void {
    this.#held.add(usage);
    this.#report();
    this.#held.delete(usage);
    this.#report();
  }

  override close(): Promise<void> {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    return super.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export type Status = "closed" | "opening" | "open";

const MAX_PRESSES = 12;

let keypad: StormNavPad | null = null;
let keys: StormNavPadKeys | null = null;
let mockKeyboard: MockKeyboard | null = null;
let status: Status = "closed";
let mock = false;
let info: NavPadStatus | null = null;
/** Keys held right now, by name (or `0x..` for a usage outside the keypad's table). */
let held: string[] = [];
let presses: { at: string; key: string }[] = [];
/** The jack's settled state; unknown until the first change after connecting. */
let jack: boolean | null = null;

const usbId = [STORM_VENDOR_ID, NAV_PAD_PRODUCT_ID].map((id) => id.toString(16).padStart(4, "0")).join(":");

export const state = () => ({
  status,
  mock,
  usbId,
  firmware: info?.firmware ?? null,
  serial: info?.serial ?? null,
  keypadType: info?.keypadType ?? null,
  keyTable: info?.keyTable ?? null,
  led: info?.led ?? null,
  jackLed: info?.jackLed ?? null,
  keypressBeep: info?.keypressBeep ?? null,
  held,
  presses,
  jack,
  /** The driver's own vocabularies, so the page keeps no copy. */
  keys: KEYS,
  maxLed: MAX_LED_LEVEL,
});

const tell = () => announce("storm", state());

export function configure(options: { mock: boolean }): void {
  // A device opened in one mode must never carry on into the other.
  if (status !== "closed") throw new Error("Disconnect before changing mode");
  mock = options.mock;
  tell();
}

const nameOf = (event: NavPadKeyEvent) => event.key ?? `0x${event.usage.toString(16).padStart(2, "0")}`;

function wire(opened: StormNavPadKeys): void {
  opened.on("keydown", (event: NavPadKeyEvent) => {
    if (keys !== opened) return;
    const key = nameOf(event);
    held = [...held, key];
    presses = [{ at: new Date().toISOString().slice(11, 23), key }, ...presses].slice(0, MAX_PRESSES);
    log("info", `Key ${key} pressed`);
    tell();
  });
  opened.on("keyup", (event: NavPadKeyEvent) => {
    if (keys !== opened) return;
    held = held.filter((key) => key !== nameOf(event));
    tell();
  });
  opened.on("jack", (event: NavPadJackEvent) => {
    if (keys !== opened) return;
    jack = event.inserted;
    log("info", event.inserted ? "Headset plugged in" : "Headset unplugged");
    tell();
  });
  // The capture loop ends when its reports stop: the keypad went away.
  opened.on("disconnect", () => {
    if (keys !== opened) return;
    const lost = keypad;
    keys = null;
    keypad = null;
    mockKeyboard = null;
    reset();
    log("error", "The keypad stopped reporting. Reconnect to continue.");
    tell();
    void lost?.close().catch(() => {});
  });
}

function reset(): void {
  status = "closed";
  info = null;
  held = [];
  presses = [];
  jack = null;
}

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();
  log("info", mock ? "Opening mock Nav-Pad" : `Opening ${usbId}: command channel, then key capture`);
  let capture: StormNavPadKeys | null = null;
  try {
    if (mock) {
      keypad = StormNavPad.withTransport(new MockCommands());
      info = await keypad.status();
      mockKeyboard = new MockKeyboard();
      capture = StormNavPadKeys.withTransport(mockKeyboard, info.keycodes);
    }
    else {
      const transport = new HIDTransport(STORM_VENDOR_ID, NAV_PAD_PRODUCT_ID, {
        usagePage: STORM_USAGE_PAGE, // the vendor channel, not the keyboard interface
        output: STORM_REPORTS,
        input: STORM_REPORTS,
      });
      await transport.open();
      keypad = StormNavPad.withTransport(transport);
      info = await keypad.status();
      // Name presses through the table the keypad reports, not an assumed default.
      capture = await StormNavPadKeys.open({ keycodes: info.keycodes });
    }
  }
  catch (err) {
    await capture?.close().catch(() => {});
    await keypad?.close().catch(() => {});
    keypad = null;
    mockKeyboard = null;
    reset();
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  keys = capture;
  wire(capture);
  status = "open";
  tell();
  log("ok", `Nav-Pad ${info.serial} answered, firmware ${info.firmware}; key capture is exclusive`);
}

export async function disconnect(): Promise<void> {
  const open = keypad;
  const capture = keys;
  if (!open) return;
  keypad = null;
  keys = null;
  mockKeyboard = null;
  reset();
  // Leave it dark; the level is not saved, so a power cycle restores the unit's own.
  await open.setLed(0).catch(() => {});
  await capture?.close().catch(() => {});
  await open.close().catch(() => {});
  tell();
  log("info", "Keypad released to the OS");
}

function current(): StormNavPad {
  if (!keypad) throw new Error("Not connected");
  return keypad;
}

/** Re-read the status, so the page shows what the keypad holds rather than what was asked. */
async function refresh(): Promise<void> {
  info = await current().status();
  tell();
}

function level(body: Record<string, unknown>): number {
  const value = body.level;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_LED_LEVEL) {
    throw new Error(`level must be an integer 0..${MAX_LED_LEVEL}`);
  }
  return value as number;
}

export const actions: Record<string, (body: Record<string, unknown>) => unknown> = {
  status: () => refresh(),
  led: async (body) => {
    const value = level(body);
    await current().setLed(value);
    log("sent", `Light ${value}/${MAX_LED_LEVEL}`);
    await refresh();
  },
  "jack-led": async (body) => {
    const value = level(body);
    await current().setJackLed(value);
    log("sent", `Jack LED ${value}/${MAX_LED_LEVEL}`);
    await refresh();
  },
  "keypress-beep": async (body) => {
    if (typeof body.on !== "boolean") throw new Error("on must be true or false");
    await current().setKeypressBeep(body.on);
    log("sent", `Keypress beep ${body.on ? "on" : "off"}`);
    await refresh();
  },
  buzz: async (body) => {
    const quarters = body.quarters;
    // The driver takes up to 255 quarter-seconds; a minute of beeping is never a test.
    if (!Number.isInteger(quarters) || (quarters as number) < 1 || (quarters as number) > 8) {
      throw new Error("quarters must be an integer 1..8");
    }
    await current().buzz(quarters as number);
    log("sent", `Buzz ${(quarters as number) / 4}s`);
  },
  /** Mock only: a key pressed, or a headset plugged in or out. */
  simulate: (body) => {
    if (!mock || !mockKeyboard) throw new Error("Only a mock keypad has simulated keys");
    if (body.event === "press") {
      if (!(KEYS as readonly unknown[]).includes(body.key)) throw new Error(`'${body.key}' is not a Nav-Pad key`);
      mockKeyboard.press(usageOf(body.key as string));
    }
    else if (body.event === "jack") {
      if (typeof body.inserted !== "boolean") throw new Error("inserted must be true or false");
      mockKeyboard.tap(usageOf(body.inserted ? "jack-inserted" : "jack-removed"));
    }
    else throw new Error(`unknown event '${body.event}'`);
  },
};

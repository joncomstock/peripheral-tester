/**
 * The Access-IS ADR300 document reader, as one device of the tester.
 *
 * What hardware-libs' driver reaches, and so what this tests: the reader's vendor HID channel, which
 * drives the illumination (visible, infrared, ultraviolet), the status LEDs and the sounder, and
 * answers the firmware, FPGA and PSoC versions. The page image is a standard UVC camera the OS
 * presents on its own; the driver does not read it, so nothing here sees a document, its MRZ or a
 * barcode, and the device reports no document presence on this channel. Camera reset is left out
 * on purpose: it drops the reader off USB.
 *
 * Only reads are answered and nothing arrives unasked, so a reader that went away shows up as a
 * command failing on a closed transport; that is when this session says so.
 *
 * @module
 */

import type { MessageTransport } from "@eai/models";
import {
  ADR300_PID,
  ADR300_VID,
  Adr300Reader,
  CameraRegister,
  Direction,
  Illumination,
  ILLUMINATION_PROFILES,
  openAdr300,
  RegisterRegister,
  SounderPattern,
  Subsystem,
} from "@eai/access-is/adr300";
import type { LedColor, LedSide } from "@eai/access-is/adr300";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("adr300", kind, text);

/** The driver types these but exports no list of them; `satisfies` keeps the copy honest. */
const LED_COLORS = ["blue", "amber", "green", "red", "all"] as const satisfies readonly LedColor[];
const LED_SIDES = ["both", "left", "right"] as const satisfies readonly LedSide[];

type IlluminationName = keyof typeof Illumination;
type SoundName = keyof typeof SounderPattern;

// ---------------------------------------------------------------------------------------------
// A fake reader, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

/**
 * Speaks enough of the ADR300's HID channel to drive the real driver: 64-byte commands
 * `[3 + payload length, subsystem, register, direction, ...payload]`. Reads are answered with the
 * register's bytes in a 64-byte report; writes, like the device's, are not answered. A read it does
 * not know goes unanswered too, which the driver times out on as it would on a real unit.
 */
class MockAdr300 implements MessageTransport {
  isOpen = true;
  #inbound: Uint8Array[] = [];
  #wake: (() => void) | null = null;
  /** The illumination mode last written; a read answers with the LED profile code for it. */
  #illumination = 0;

  /** The cable is pulled. */
  unplug(): void {
    this.close();
  }

  send(message: Uint8Array): Promise<void> {
    if (!this.isOpen) return Promise.reject(new Error("HID device is not open"));
    const [, subsystem, register, direction] = message;
    if (direction === Direction.Write) {
      if (subsystem === Subsystem.Camera && register === CameraRegister.Illumination) this.#illumination = message[4];
      return Promise.resolve();
    }
    const profile = [...ILLUMINATION_PROFILES].find(([, mode]) => mode === this.#illumination)?.[0] ?? 0;
    const replies: Record<string, number[]> = {
      [`${Subsystem.Camera}/${CameraRegister.FirmwareVersion}`]: [0x00, 0x25],
      [`${Subsystem.Camera}/${CameraRegister.FpgaVersion}`]: [0x01, 0x02],
      [`${Subsystem.Registers}/${RegisterRegister.PsocVersion}`]: [0x05, 0x00],
      [`${Subsystem.Camera}/${CameraRegister.Illumination}`]: [profile >> 8, profile & 0xff],
    };
    const bytes = replies[`${subsystem}/${register}`];
    if (bytes) {
      const reply = new Uint8Array(64);
      reply.set(bytes);
      this.#inbound.push(reply);
      this.#wake?.();
    }
    return Promise.resolve();
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
    this.isOpen = false;
    this.#wake?.();
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export type Status = "closed" | "opening" | "open";

let reader: Adr300Reader | null = null;
let mockReader: MockAdr300 | null = null;
let status: Status = "closed";
let mock = false;
/** As read back after each change: the reader answers with an LED profile, mapped to its mode. */
let illumination: { profile: number; mode: IlluminationName | null } | null = null;
/** What was last commanded; the device does not report its LEDs. */
let led: { color: LedColor; side: LedSide } | null = null;

const usbId = [ADR300_VID, ADR300_PID].map((id) => id.toString(16).padStart(4, "0")).join(":");

export const state = () => ({
  status,
  mock,
  usbId,
  illumination,
  led,
  /** The driver's own vocabularies, so the page keeps no copy. */
  illuminations: Object.keys(Illumination) as IlluminationName[],
  ledColors: LED_COLORS,
  ledSides: LED_SIDES,
  sounds: Object.keys(SounderPattern) as SoundName[],
});

const tell = () => announce("adr300", state());

export function configure(options: { mock: boolean }): void {
  // A device opened in one mode must never carry on into the other.
  if (status !== "closed") throw new Error("Disconnect before changing mode");
  mock = options.mock;
  tell();
}

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();
  log("info", mock ? "Opening mock ADR300" : `Opening ${usbId} over USB HID`);
  try {
    if (mock) {
      mockReader = new MockAdr300();
      reader = Adr300Reader.withTransport(mockReader);
    }
    else {
      reader = await openAdr300();
    }
    await readIllumination(reader);
  }
  catch (err) {
    await reader?.close().catch(() => {});
    reader = null;
    mockReader = null;
    status = "closed";
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  status = "open";
  tell();
  log("ok", "Reader answered");
}

/** The reader as it is now, and the mode its profile code means. */
async function readIllumination(open: Adr300Reader): Promise<void> {
  const read = await open.illumination();
  const mode = (Object.keys(Illumination) as IlluminationName[]).find((name) => Illumination[name] === read.mode) ?? null;
  illumination = { profile: read.profile, mode };
}

export async function disconnect(): Promise<void> {
  const open = reader;
  if (!open) return;
  reader = null;
  status = "closed";
  // Leave it dark and quiet.
  try {
    await open.setIllumination(Illumination.Off);
    await open.ledsOff();
  }
  catch { /* a reader already unreachable cannot be darkened */ }
  await open.close();
  mockReader = null;
  illumination = null;
  led = null;
  tell();
  log("info", "Reader released");
}

/**
 * Run a command, and notice a reader that went away under it. The channel carries nothing unasked,
 * so a failed command on a closed transport is the only sign.
 */
async function run<T>(work: (open: Adr300Reader) => Promise<T>): Promise<T> {
  const open = reader;
  if (!open) throw new Error("Not connected");
  try {
    return await work(open);
  }
  catch (err) {
    if (!open.isOpen && reader === open) {
      reader = null;
      mockReader = null;
      status = "closed";
      illumination = null;
      led = null;
      await open.close().catch(() => {});
      tell();
      log("error", "The reader stopped answering. Reconnect to continue.");
    }
    else log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new Error(`'${value}' is not ${what}`);
  return value as T;
}

export const actions: Record<string, (body: Record<string, unknown>) => unknown> = {
  /** Light an illumination mode by name, then read back what the reader reports. */
  illumination: (body) => {
    const mode = oneOf(body.mode, state().illuminations, "an illumination mode");
    return run(async (open) => {
      await open.setIllumination(Illumination[mode]);
      await readIllumination(open);
      tell();
      log("sent", `Illumination ${mode}`);
    });
  },

  /** A status LED colour on one or both sides, or `off` for all of them. */
  led: (body) => {
    if (body.color === "off") {
      return run(async (open) => {
        await open.ledsOff();
        led = null;
        tell();
        log("sent", "LEDs off");
      });
    }
    const color = oneOf(body.color, LED_COLORS, "an LED colour");
    const side = body.side === undefined ? "both" : oneOf(body.side, LED_SIDES, "an LED side");
    return run(async (open) => {
      await open.setLed(color, side);
      led = { color, side };
      tell();
      log("sent", `LED ${color}${side === "both" ? "" : ` (${side})`}`);
    });
  },

  /** Play one of the driver's canned sounder patterns. */
  sound: (body) => {
    const pattern = oneOf(body.pattern, state().sounds, "a sounder pattern");
    return run(async (open) => {
      await open.sound(SounderPattern[pattern]);
      log("sent", `Sounder ${pattern}`);
    });
  },

  /** Firmware, FPGA and PSoC versions. FPGA is null on units that do not answer it. */
  identity: () =>
    run(async (open) => {
      const versions = await open.versions();
      const hex = (value: number | null) => value === null ? "—" : `0x${value.toString(16).padStart(2, "0")}`;
      log("info", `Firmware ${hex(versions.firmware)} · FPGA ${hex(versions.fpga)} · PSoC ${versions.psoc}`);
      return versions;
    }),

  /** Pull the mock's cable, to see a lost reader reported. The page offers this only when mocking. */
  simulate: (body) => {
    if (!mock || !mockReader) throw new Error("Only a mock reader can be simulated");
    oneOf(body.event, ["unplug"], "a simulation");
    mockReader.unplug();
    log("info", "Mock: cable pulled");
  },
};

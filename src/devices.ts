/**
 * Which peripherals a 919 has, and which of them this tester can drive.
 *
 * The rail lists all of them. A device whose driver exists but whose screen does not is shown
 * rather than hidden — knowing what a kiosk has is worth more to someone standing at one than a
 * shorter list, and the note says exactly what is missing so nobody has to guess whether it is the
 * hardware or the tester.
 *
 * The three wired ones are the only ids the backend knows; the rest are catalogue entries.
 */

import type { Snapshot, Status } from "./api.ts";
import { usbId } from "./format.ts";
import { LAMP } from "./look.ts";
import type { LampMode, Tone } from "./look.ts";

/** A device the backend holds a handle for. Every API call and log line is tagged with one. */
export type WiredId = "lightboard" | "cardreader" | "passportreader";

export type DeviceId = WiredId | "barcode" | "imager" | "rfid" | "bpprinter" | "payment";

export interface DeviceEntry {
  id: DeviceId;
  name: string;
  model: string;
  /** The transport, without the address — the address is live and comes from the snapshot. */
  bus: string;
  /** True when this tester can actually drive it, which is what puts a screen behind the row. */
  ready: boolean;
  /** The driver package, for a device whose screen is not built. */
  pkg?: string;
  note?: string;
}

export const DEVICES: DeviceEntry[] = [
  { id: "lightboard", name: "Light Board", model: "IER S33380", bus: "RS-232", ready: true },
  { id: "cardreader", name: "Card Reader", model: "Hitachi-Omron V4KU", bus: "USB HID", ready: true },
  { id: "passportreader", name: "Passport Reader", model: "DESKO PENTA", bus: "USB FFI", ready: true },
  {
    id: "barcode",
    name: "Barcode Scanner",
    model: "Honeywell N56xx",
    bus: "USB serial",
    ready: false,
    pkg: "@eai/honeywell/n56xx",
    note:
      "The driver covers single scan, presentation mode, symbology configuration and teardown. The tester screen is not built yet.",
  },
  {
    id: "imager",
    name: "Imaging Scanner",
    model: "Honeywell Vuquest 3310g",
    bus: "USB serial",
    ready: false,
    pkg: "@eai/honeywell/vuquest3310g",
    note:
      "The driver covers single scan, presentation mode, imaging capture and signature capture. The tester screen is not built yet.",
  },
  {
    id: "rfid",
    name: "RFID Reader",
    model: "Access-IS ADR300",
    bus: "USB HID",
    ready: false,
    pkg: "@eai/access-is/adr300",
    note:
      "The driver wraps the vendor SDK with its own Win32 message pump and lifecycle. The tester screen is not built yet.",
  },
  {
    id: "bpprinter",
    name: "Boarding Pass Printer",
    model: "Practical Automation ITK38",
    bus: "TCP/IP",
    ready: false,
    pkg: "@eai/practical-automation/itk38",
    note: "The driver covers status flags, encoding and the print path over the documented protocol. The tester screen is not built yet.",
  },
  {
    id: "payment",
    name: "Payment Terminal",
    model: "Not yet selected",
    bus: "—",
    ready: false,
    note: "No driver yet — the terminal has not been chosen.",
  },
];

export const WIRED: WiredId[] = ["lightboard", "cardreader", "passportreader"];

export const isWired = (id: DeviceId): id is WiredId => (WIRED as DeviceId[]).includes(id);

/** Whether a remembered id still names a device. An old build may have written one that is gone. */
export const isDeviceId = (value: string): value is DeviceId => DEVICES.some((device) => device.id === value);

export function deviceEntry(id: DeviceId): DeviceEntry {
  const entry = DEVICES.find((d) => d.id === id);
  // Thrown rather than defaulted. `DeviceId` is closed, so this cannot happen from typed code —
  // and the alternative, returning `DEVICES[0]`, would silently put the light board's name over
  // another peripheral's screen, which is the failure the rest of this app is careful to avoid.
  if (!entry) throw new Error(`no such device: ${id}`);
  return entry;
}

/** One place the three device slices are addressed by id, so nothing re-derives the mapping. */
export const statusOf = (snapshot: Snapshot, id: WiredId): Status =>
  id === "lightboard" ? snapshot.lightboard.status : id === "cardreader" ? snapshot.cardreader.status : snapshot.passportreader.status;

/** Whether the backend is holding this device's handle right now. */
export const isLive = (snapshot: Snapshot, id: DeviceId): boolean => isWired(id) && statusOf(snapshot, id) === "open";

/**
 * What a device's badge says, and how the lamp beside it behaves.
 *
 * Shared by the rail and the bus list. They had a cascade each over the same four inputs, and the
 * bus one had already fallen behind — it did not know about a handshake in flight, so a device the
 * rail showed as "Testing" showed there as "Idle".
 */
export function verdict(
  { ready, live, testing, pass }: { ready: boolean; live: boolean; testing: boolean; pass?: boolean },
): { tone: Tone; text: string; mode: LampMode; color: string } {
  if (!ready) return { tone: "neutral", text: "Planned", mode: "off", color: LAMP.green };
  if (testing) return { tone: "warn", text: "Testing", mode: "pulse", color: LAMP.amber };
  if (pass === false) return { tone: "bad", text: "Refused", mode: "on", color: LAMP.red };
  if (live) return { tone: "ok", text: "Live", mode: "on", color: LAMP.green };
  if (pass === true) return { tone: "ok", text: "Claimable", mode: "on", color: LAMP.green };
  return { tone: "neutral", text: "Idle", mode: "off", color: LAMP.green };
}

/**
 * The transport and the address, as the backend currently knows them.
 *
 * The passport reader's USB ids are only known once the DLL has opened a unit, so before that this
 * names the API rather than inventing a pair.
 */
export function busLine(snapshot: Snapshot, id: DeviceId): string {
  const entry = deviceEntry(id);
  if (id === "lightboard") return `${entry.bus} · ${snapshot.lightboard.portName}`;
  if (id === "cardreader") {
    const { vendorId, productId } = snapshot.cardreader.usb;
    return `${entry.bus} · ${usbId(vendorId)}:${usbId(productId)}`;
  }
  if (id === "passportreader") {
    const device = snapshot.passportreader.device;
    return device
      ? `${entry.bus} · ${usbId(device.vendorId)}:${usbId(device.productId)}`
      : `${entry.bus} · FullPage API`;
  }
  return entry.bus;
}

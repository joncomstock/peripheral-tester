/**
 * Every peripheral `hardware-libs` has a driver for, which kiosks fit them, and which of them this
 * tester can drive.
 *
 * The catalogue is the whole of `hardware-libs`, not one kiosk's bill of materials — a device whose
 * driver exists but whose screen does not is listed rather than hidden, and the note says exactly
 * what is missing so nobody has to guess whether it is the hardware or the tester.
 *
 * The rail shows a *chosen* subset of it, because a bench is one kiosk at a time. `KIOSKS` names
 * the units Elevation AI actually has, so choosing one is a single press rather than fourteen.
 *
 * The three wired ones are the only ids the backend knows; the rest are catalogue entries.
 *
 * **Kept by hand, and it has to be.** `hardware-libs` is a separate repo whose packages are all
 * unpublished and spread across unmerged branches — there is nothing this app could import or read
 * at build time that would know the whole set. So a driver that lands there does not appear here
 * until somebody adds it, and `deviceChoice.test.ts` can only check this file against itself.
 * When you touch a driver in `hardware-libs`, come back here.
 */

import type { Snapshot, Status } from "./api.ts";
import { usbId } from "./format.ts";
import { LAMP } from "./look.ts";
import type { LampMode, Tone } from "./look.ts";

/** A device the backend holds a handle for. Every API call and log line is tagged with one. */
export type WiredId = "lightboard" | "cardreader" | "passportreader";

export type DeviceId =
  | WiredId
  | "barcode"
  | "imager"
  | "atr200"
  | "documentreader"
  | "facepod"
  | "bpprinter"
  | "xpm"
  | "keypad"
  | "speech"
  | "volume"
  | "payment";

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
    id: "atr200",
    name: "Presentation Scanner",
    model: "Access-IS TripTick ATR200",
    bus: "USB CDC",
    ready: false,
    // `/atr200`, not the `/barcode` the first cut of the driver exported. The rename is on the
    // newer `atr200-ns-work`, which also split the scanner out of the barrel; the branch carrying
    // `/barcode` is behind a closed PR.
    pkg: "@eai/access-is/atr200",
    note:
      "A barcode reader, not a document scanner: it free-runs and pushes each decode. Validated on-device against 1D, PDF417 and QR.",
  },
  {
    id: "documentreader",
    name: "Document Reader",
    model: "Access-IS ADR300",
    bus: "USB HID",
    ready: false,
    pkg: "@eai/access-is/adr300",
    // Named for what it is. It was "RFID Reader" here, which the driver contradicts —
    // `Adr300DocumentReaderLifecycle`, `DocumentReaderConfig` — as does the unit survey: a
    // flat-window reader for the MRZ and barcodes of travel documents. The mistake only became
    // load-bearing once a kiosk preset started labelling the V1's document reader with it.
    note:
      "Reads the MRZ and barcodes of a travel document. The driver wraps the vendor SDK with its own Win32 message pump and lifecycle.",
  },
  {
    id: "facepod",
    name: "Face Module",
    model: "HID U.ARE.U FacePod",
    bus: "USB FFI",
    ready: false,
    pkg: "@eai/hid/facepod",
    note:
      "Camera context, capture with liveness, image-to-template and 1:1 matching. facepod-tester drives it, so no screen here.",
  },
  {
    id: "bpprinter",
    name: "Boarding Pass Printer",
    model: "Practical Automation ITK38",
    bus: "TCP/IP",
    ready: false,
    pkg: "@eai/itk38",
    note: "The driver covers status flags, encoding and the print path over the documented protocol. The tester screen is not built yet.",
  },
  {
    id: "xpm",
    name: "Thermal Printer",
    model: "Hengstler XPM-200",
    bus: "USB bulk",
    ready: false,
    pkg: "@eai/xpm",
    note:
      "The driver covers the XPM-80, XPM-200 and XPM-200HR over USB bulk, behind the same interface as @eai/itk38.",
  },
  {
    id: "keypad",
    name: "Navigation Keypad",
    model: "Storm NavPad / AudioNav / uNav",
    bus: "USB HID",
    ready: false,
    pkg: "@eai/storm",
    note:
      "The driver covers all three variants over Win32 HID, with a raw-input path for the function keys.",
  },
  {
    id: "speech",
    name: "Speech",
    model: "Win32 SAPI",
    bus: "Win32 COM",
    ready: false,
    pkg: "@eai/tts",
    note: "The driver wraps Win32 SAPI text-to-speech over COM. The tester screen is not built yet.",
  },
  {
    id: "volume",
    name: "Audio Volume",
    model: "Win32 Core Audio",
    bus: "Win32 COM",
    ready: false,
    pkg: "@eai/volume",
    note: "The driver wraps Win32 Core Audio volume over COM. The tester screen is not built yet.",
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

/**
 * A kiosk Elevation AI has, and the devices in it this repo has a driver for.
 *
 * `without` is the rest of that kiosk's bill of materials — the components `hardware-libs` has no
 * driver for. Named rather than omitted, because a V1 preset that ticks one box out of four reads
 * as a bug unless it says why: the kiosk has four devices, and three of them nothing here can open.
 *
 * The lists come from the unit surveys in the company KB, not from a datasheet — plus whatever
 * this repo has since driven on the unit itself. The 919's light board is the case in point: the
 * KB survey does not mention it, because the S33380 was found and driven here, on a 919, after
 * that note was written. Add to a list from evidence, not from a brochure.
 */
export interface KioskModel {
  id: string;
  name: string;
  devices: DeviceId[];
  without?: string;
}

export const KIOSKS: KioskModel[] = [
  {
    id: "ier919",
    name: "IER 919",
    devices: ["lightboard", "cardreader", "passportreader", "xpm"],
    without: "Also fits an IER 400 ATB printer — no driver in hardware-libs.",
  },
  {
    id: "embrossv1",
    name: "Embross V1",
    devices: ["documentreader"],
    without:
      "Also fits a Datalogic GFS4470 scanner, a Custom KPM180H printer and an ID TECH card reader — no drivers in hardware-libs.",
  },
  {
    id: "sitad4",
    name: "SITA D4",
    devices: ["imager", "bpprinter"],
    without: "Also fits a Gemalto KR2400 and a Nidec ICM330 card reader — no drivers in hardware-libs.",
  },
  {
    id: "ncr120",
    name: "NCR Touchport 120",
    devices: ["barcode"],
    without: "Also fits a K8 boarding-pass printer — no driver in hardware-libs.",
  },
];

/**
 * What the tester opens on before anyone has chosen: the kiosk all three built screens belong to.
 *
 * Copied, not aliased. Exported as-is it is the same array object the preset holds, so it would
 * reach React state and a `KIOSKS` entry could be edited from outside the module.
 */
export const DEFAULT_DEVICES: DeviceId[] = [...KIOSKS[0].devices];

/**
 * Which kiosk a selection is exactly, or null when it was picked by hand.
 *
 * Derived rather than stored beside the selection. A remembered "this is a 919" that has drifted
 * from the boxes actually ticked is a second source of truth, and the one the dropdown would show.
 */
export function kioskOf(selected: DeviceId[]): KioskModel | null {
  return KIOSKS.find((kiosk) =>
    kiosk.devices.length === selected.length && kiosk.devices.every((id) => selected.includes(id))
  ) ?? null;
}

/**
 * Add or remove one device, never emptying the rail.
 *
 * The last remaining device cannot be removed. An empty rail is not a state this app has a screen
 * for — there would be nothing to select and nothing to render — so it is refused here rather than
 * guarded for everywhere downstream.
 */
export function toggleDevice(selected: DeviceId[], id: DeviceId): DeviceId[] {
  if (selected.includes(id)) return selected.length === 1 ? selected : selected.filter((each) => each !== id);
  return DEVICES.filter((device) => device.id === id || selected.includes(device.id)).map((device) => device.id);
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

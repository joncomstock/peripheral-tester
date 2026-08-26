/**
 * Every peripheral `hardware-libs` has a driver for, which kiosks fit them, and which of them this
 * tester can drive.
 *
 * The catalogue is the whole of `hardware-libs`, not one kiosk's bill of materials — a device whose
 * driver exists but whose screen does not is listed rather than hidden, and the note says exactly
 * what is missing so nobody has to guess whether it is the hardware or the tester.
 *
 * The rail shows a *chosen* subset of it, because a bench is one kiosk at a time. `KIOSKS` names
 * the units Elevation AI actually has, so choosing one is a single press rather than a whole
 * catalogue of ticks.
 *
 * The three wired ones are the only ids the backend knows; the rest are catalogue entries.
 *
 * **Kept by hand, and it has to be.** `hardware-libs` is a separate repo, and the drivers are
 * spread across branches that have not merged — there is nothing this app could import or read at
 * build time that would know the whole set. So a driver that lands there does not appear here
 * until somebody adds it, and `deviceChoice.test.ts` can only check this file against itself.
 * When you touch a driver in `hardware-libs`, come back here.
 *
 * One driver per device, at its newest package name. `hardware-libs` also carries earlier
 * generations of several of these — `@eai/honeywell-n56xx` before `@eai/honeywell/n56xx`,
 * `@eai/pa-itk38` before `@eai/itk38`, `@eai/hengstler` before `@eai/xpm`, `@eai/node-usb` before
 * `@eai/usb` — and those are left out on purpose rather than missed. Left out too are the
 * libraries that are not a device at all: `@eai/usb`, `@eai/serial` and `@eai/hotplug`, and the
 * two printer protocol bases — `@eai/aea-printer`, which the Custom 180 builds on, and
 * `@eai/thermal-printer`, whose only consumers were the superseded generations above. The K8
 * builds on neither: it carries its own USB layer and adapts to the external `aea-emulator-ts`.
 */

import type { Snapshot, Status } from "./api.ts";
import { usbId } from "./format.ts";
import { LAMP } from "./look.ts";
import type { LampMode, Tone } from "./look.ts";

/**
 * A device the backend holds a handle for. Every API call and log line is tagged with one.
 *
 * Imported as well as re-exported: a bare `export ... from` forwards the name without binding it
 * here, so everything in this file that names `WiredId` would be referring to nothing.
 */
import type { WiredId } from "./api.ts";
export type { WiredId };

export type DeviceId =
  | WiredId
  | "barcode"
  | "imager"
  | "atr200"
  | "documentreader"
  | "facepod"
  | "biocamera"
  | "bpprinter"
  | "xpm"
  | "custom180"
  | "k8"
  | "ledboard"
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
  /**
   * The driver package.
   *
   * Carried by every device with a driver, not only the ones whose screen is missing: `Planned`
   * names it to say where the work is, and `Unavailable` names it to say which branch to put the
   * backend's checkout on. Absent only for hardware nobody has chosen yet.
   */
  pkg?: string;
  note?: string;
}

export const DEVICES: DeviceEntry[] = [
  { id: "lightboard", name: "Light Board", model: "IER S33380", bus: "RS-232", ready: true, pkg: "@eai/ier/s33380" },
  { id: "cardreader", name: "Card Reader", model: "Hitachi-Omron V4KU", bus: "USB HID", ready: true, pkg: "@eai/omron/v4ku" },
  { id: "passportreader", name: "Passport Reader", model: "DESKO PENTA", bus: "USB FFI", ready: true, pkg: "@eai/desko/penta" },
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
    // Not "Barcode Reader": that is the Honeywell's name with one word swapped, and the two would
    // sit adjacent in the picker telling a bench operator apart only by their model line. TripTick
    // is Access-IS's boarding-pass line and the validated decodes are boarding-pass PDF417.
    name: "Boarding Pass Reader",
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
    id: "biocamera",
    name: "Biometric Camera",
    model: "China Creator ZS-ATMC",
    bus: "USB FFI",
    ready: false,
    pkg: "@eai/china-creator",
    note:
      "Lifecycle across USB hotplug, liveness detection and 1:1 face comparison, over two vendor DLLs.",
  },
  {
    id: "bpprinter",
    name: "Boarding Pass Printer",
    model: "Practical Automation ITK38",
    // USB, not the TCP/IP this said before the SITA D4 preset started leaning on it. The driver
    // README is unambiguous: "Communicates over USB using @eai/usb (FFI to libusb-1.0)".
    bus: "USB bulk",
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
    id: "custom180",
    name: "BP & Bag Tag Printer",
    model: "Custom 180 (KPM180-H)",
    bus: "USB bulk",
    ready: false,
    pkg: "@eai/custom-180",
    note: "The driver prints in both boarding-pass and bag-tag modes over the AEA protocol, with a sub-module for each.",
  },
  {
    id: "k8",
    name: "ATB Printer",
    model: "K8 (NCR / Custom ATB)",
    bus: "USB bulk",
    ready: false,
    pkg: "@eai/k8",
    note: "The driver covers the NCR and Custom ATB thermal series, as a raw USB driver and as an AEAEmulator adapter.",
  },
  {
    id: "ledboard",
    name: "LED Board",
    model: "Kiosk Innovations",
    bus: "RS-232",
    ready: false,
    pkg: "@eai/ki-led-board",
    note: "A second indicator board, unrelated to the 919's S33380. The driver speaks it over a raw serial transport.",
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
 * driver for. Named rather than omitted, because a preset that ticks fewer boxes than the unit in
 * front of you has devices reads as a bug unless it says why. A kiosk with nothing uncovered has
 * no `without` at all, which is how the two cases stay distinguishable.
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
    // `@eai/aea-printer` is a generic AEA base, not an IER 400 driver, so this stays a gap
    // rather than becoming another tick.
    without: "Also fits an IER 400 ATB printer — hardware-libs has the AEA base but no IER 400 driver.",
  },
  {
    id: "embrossv1",
    name: "Embross V1",
    devices: ["documentreader", "custom180"],
    without: "Also fits a Datalogic GFS4470 scanner and an ID TECH card reader — no drivers in hardware-libs.",
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
    // Both of this unit's components have a driver, so there is nothing for `without` to say.
    devices: ["barcode", "k8"],
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
  return DEVICES.filter((entry) => entry.id === id || selected.includes(entry.id)).map((entry) => entry.id);
}

/**
 * One place the three device slices are addressed by id, so nothing re-derives the mapping.
 *
 * `null` when the backend has no driver for this device in its checkout: there is no handle, so
 * there is no status — which is a different thing from a handle that is closed.
 */
export const statusOf = (snapshot: Snapshot, id: WiredId): Status | null =>
  id === "lightboard"
    ? snapshot.lightboard?.status ?? null
    : id === "cardreader"
    ? snapshot.cardreader?.status ?? null
    : snapshot.passportreader?.status ?? null;

/**
 * Why this device's driver is not in the backend's checkout, in the driver's own words.
 *
 * The drivers live on `hardware-libs` branches that have not merged, so which of them the backend
 * can resolve depends on the branch it is on. Undefined means it resolved.
 */
export const absenceOf = (snapshot: Snapshot, id: DeviceId): string | undefined =>
  isWired(id) ? snapshot.absent[id] : undefined;

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
  { ready, live, testing, pass, absent }: {
    ready: boolean;
    live: boolean;
    testing: boolean;
    pass?: boolean;
    /** True when the backend has no driver for this device in its checkout. */
    absent?: boolean;
  },
): { tone: Tone; text: string; mode: LampMode; color: string } {
  /*
   * Before "Planned", because it is the more specific answer and the two are different problems.
   * "Planned" means this tester has no screen for a driver that exists; this means the backend's
   * checkout is on a branch that does not carry the driver at all, which a branch switch fixes.
   */
  if (absent) return { tone: "warn", text: "No driver", mode: "off", color: LAMP.amber };
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
  // No driver, no address. The bus is still worth saying — it is what the device *is*, not what
  // this backend can currently reach.
  if (absenceOf(snapshot, id) !== undefined) return `${entry.bus} · driver not in this checkout`;
  if (id === "lightboard" && snapshot.lightboard) return `${entry.bus} · ${snapshot.lightboard.portName}`;
  if (id === "cardreader" && snapshot.cardreader) {
    const { vendorId, productId } = snapshot.cardreader.usb;
    return `${entry.bus} · ${usbId(vendorId)}:${usbId(productId)}`;
  }
  if (id === "passportreader" && snapshot.passportreader) {
    const device = snapshot.passportreader.device;
    return device
      ? `${entry.bus} · ${usbId(device.vendorId)}:${usbId(device.productId)}`
      : `${entry.bus} · FullPage API`;
  }
  return entry.bus;
}

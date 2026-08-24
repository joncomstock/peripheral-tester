/**
 * The DESKO PENTA Scanner, as one device of the tester.
 *
 * **Document data never leaves this module except in the reply to the read that produced it.**
 * An MRZ carries a name, a nationality, a date of birth and a document number, and the scanned
 * image carries the printed page and the portrait with it. That is the same class of data as the
 * card reader's PAN, so it gets the same rule: the activity log is told that a document was read,
 * which layout it was and whether the check digits verified — never the fields, never the lines,
 * and never the image. Masking for display is the page's job; not recording it is this one's.
 *
 * @module
 */

import { createMockPageScanLib, DeskoPenta } from "@eai/desko/penta";
import type {
  BarcodeRead,
  DocumentImage,
  ImageFormat,
  LedColorName,
  LightSourceName,
  MockPageScan,
  MrzRead,
  ResolutionName,
} from "@eai/desko/penta";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("passportreader", kind, text);

// ---------------------------------------------------------------------------------------------
// A synthetic scan, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

/** An ICAO 9303 specimen passport. Utopia is the standard's own fictional issuer. */
const DEMO_MRZ = [
  "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
  "L898902C36UTO7408122F1204159ZE184226B<<<<<10",
];

/** The same specimen with a character the OCR could not classify, so a partial read is drivable. */
const SMUDGED_MRZ = [DEMO_MRZ[0], "L8989*2C36UTO7408122F1204159ZE184226B<<<<<10"];

/** A BCBP boarding pass, the barcode this device meets most often at a gate. */
const DEMO_BARCODE = "M1ERIKSSON/ANNA MARIA EABC123 LHRJFKBA 0117 234Y012A0001 100";

/** What the mock will produce the next time the page asks it to read. */
export type NextOutcome = "passport" | "smudged" | "noDocument" | "barcodeOnly";

/**
 * A deliberately synthetic document image: a flat tint per light source, banded.
 *
 * BMP because it needs no compressor, and unmistakably fake because that is the point. A mock that
 * produced a convincing passport scan would be a mock that can produce a screenshot nobody should
 * trust, which is exactly what this tester refuses to do elsewhere.
 */
function syntheticScan(light: LightSourceName): Uint8Array {
  const width = 240;
  const height = 150;
  const rowBytes = width * 3;
  const padding = (4 - (rowBytes % 4)) % 4;
  const pixels = (rowBytes + padding) * height;
  const bytes = new Uint8Array(54 + pixels);
  const view = new DataView(bytes.buffer);

  bytes[0] = 0x42; // 'B'
  bytes[1] = 0x4d; // 'M'
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true); // pixel data offset
  view.setUint32(14, 40, true); // BITMAPINFOHEADER
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 24, true); // bits per pixel
  view.setUint32(34, pixels, true);

  // Blue, green, red — BMP stores pixels bottom-up in BGR order.
  const tint: Record<LightSourceName, [number, number, number]> = {
    ir: [90, 90, 90],
    visible: [180, 190, 200],
    uv: [140, 60, 90],
    uv3led: [160, 120, 150],
  };
  const [b, g, r] = tint[light];
  for (let y = 0; y < height; y++) {
    const row = 54 + y * (rowBytes + padding);
    for (let x = 0; x < width; x++) {
      // Diagonal banding, so the image is visibly generated rather than photographed.
      const band = ((x + y) % 40 < 20) ? 0 : 35;
      bytes[row + x * 3] = Math.min(255, b + band);
      bytes[row + x * 3 + 1] = Math.min(255, g + band);
      bytes[row + x * 3 + 2] = Math.min(255, r + band);
    }
  }
  return bytes;
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export type Status = "closed" | "opening" | "open";
export type Phase = "idle" | "scanning";

/** How often the device is asked whether a document is on the glass, while connected. */
const PRESENCE_POLL_MS = 400;

let penta: DeskoPenta | null = null;
let mockLib: MockPageScan | null = null;
let status: Status = "closed";
let phase: Phase = "idle";
let mock = false;
let dllPath: string | undefined;
let led: LedColorName | "off" = "off";
let presenceTimer: ReturnType<typeof setInterval> | undefined;
/** Guards the poll tick — see {@link startPresencePolling}. */
let polling = false;

/**
 * Whether a document is on the scan window.
 *
 * `null` means the device has not been asked yet, or answered that it cannot say — generation 3
 * units do not implement the query. A tester should show "unknown", not a confident "no".
 */
let documentPresent: boolean | null = null;

let lights: LightSourceName[] = ["ir", "visible"];
let resolution: ResolutionName = "default";

/** Filled on connect, from the device itself. */
let api: { version: number; number: number; dllVersion: string; compileDate: string } | undefined;
let device: {
  deviceType: string;
  vendorId: number;
  productId: number;
  firmware: string;
  capabilities: Record<string, boolean>;
} | undefined;

export function configure(options: { mock: boolean; dllPath?: string }): void {
  mock = options.mock;
  dllPath = options.dllPath;
}

export const state = () => ({
  status,
  phase,
  mock,
  led,
  documentPresent,
  settings: { lights: [...lights], resolution },
  api,
  device,
});

const tell = () => announce("passportreader", state());

/** The mock's device state, so the page can arm what the next read produces. */
function mockState(): MockPageScan["state"] {
  if (!mockLib) throw new Error("Only a mock scanner can be armed");
  return mockLib.state;
}

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();
  log("info", mock ? "Opening mock scanner" : "Opening PENTA over the FullPage API");

  try {
    if (mock) {
      mockLib = createMockPageScanLib({ mrzLines: DEMO_MRZ, imageBytes: syntheticScan("visible") });
      penta = new DeskoPenta(mockLib.symbols, { scanSettings: { lights, resolution } });
    }
    else {
      penta = DeskoPenta.open({ dllPath, scanSettings: { lights, resolution } });
    }
    await penta.connect();

    const info = await penta.apiInfo();
    api = { version: info.version, number: info.number, dllVersion: info.dllVersion, compileDate: info.compileDate };
    const system = await penta.deviceInfo();
    device = {
      deviceType: system.deviceType,
      vendorId: system.vendorId,
      productId: system.productId,
      firmware: `${system.firmwareVersion}.${system.firmwareNumber}`,
      capabilities: { ...system.capabilities },
    };
  }
  catch (err) {
    status = "closed";
    penta = null;
    mockLib = null;
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }

  status = "open";
  tell();
  log("ok", `Scanner opened — ${device?.deviceType}, firmware ${device?.firmware}`);
  startPresencePolling();
}

export async function disconnect(): Promise<void> {
  const open = penta;
  if (!open) return;
  penta = null;
  mockLib = null;
  status = "closed";
  phase = "idle";
  led = "off";
  documentPresent = null;
  api = undefined;
  device = undefined;
  stopPresencePolling();
  await open.close();
  tell();
  log("info", "Scanner released");
}

function held(): DeskoPenta {
  if (!penta) throw new Error("Not connected");
  return penta;
}

/**
 * Watch for a document arriving on the glass.
 *
 * The single most useful live signal on a full-page reader: an operator wants to see the page
 * notice the passport before they press anything. Only changes are announced, so a quiet window
 * produces no traffic. A device that cannot answer stops being asked.
 */
function startPresencePolling(): void {
  stopPresencePolling();
  presenceTimer = setInterval(async () => {
    const open = penta;
    // `polling` drops a tick rather than queueing it. Retrieving an image holds the driver's lock
    // for a full-page USB transfer plus an encode, and without this every tick that elapses
    // meanwhile piles up behind it, then runs back-to-back answering a question already superseded.
    if (!open || polling || phase === "scanning") return;
    polling = true;
    try {
      const present = await open.isDocumentPresent();
      if (present === documentPresent) return;
      documentPresent = present;
      tell();
    }
    catch (err) {
      // Generation 3 devices do not implement the query. Reporting "unknown" and giving up is
      // honest; asking forever would fill the log with the same refusal.
      stopPresencePolling();
      documentPresent = null;
      tell();
      log("info", `Document presence unavailable on this device (${err instanceof Error ? err.message : String(err)})`);
    }
    finally {
      polling = false;
    }
  }, PRESENCE_POLL_MS);
}

function stopPresencePolling(): void {
  if (presenceTimer !== undefined) clearInterval(presenceTimer);
  presenceTimer = undefined;
  polling = false;
}

export async function settings(next: { lights?: LightSourceName[]; resolution?: ResolutionName }): Promise<void> {
  if (next.lights !== undefined) {
    // Infrared is what the PC-side OCR reads, so a set without it arms a scan that cannot produce
    // an MRZ. Enforced here rather than only in the page: the page disables the button, but the
    // route is reachable without it, and the failure it causes is a silent `recognized: false`
    // with nothing saying why.
    lights = next.lights.includes("ir") ? next.lights : lights;
  }
  if (next.resolution !== undefined) resolution = next.resolution;
  if (penta) await penta.setScanSettings({ lights, resolution });
  tell();
  log("info", `Scan: ${lights.join(" + ")} @ ${resolution}`);
}

/**
 * A barcode, shaped for the wire.
 *
 * The driver hands up the payload as bytes, because barcode data may contain any binary. Those do
 * not survive `JSON.stringify` as anything useful — a `Uint8Array` serialises to an object of
 * numeric keys — so the decoded text and the length go across instead, which is what the page
 * shows anyway.
 */
export interface WireBarcode {
  found: boolean;
  symbology: string;
  symbologyCode: string;
  text: string;
  byteLength: number;
}

/**
 * What a read produced.
 *
 * Returned to the caller and nothing else. The activity log gets the shape of the result, never
 * its content.
 */
export interface ReadResult {
  mrz: MrzRead;
  barcode: WireBarcode;
}

// Spread rather than respelled field by field, so a field added to the driver's `BarcodeRead`
// reaches the page instead of being silently dropped here.
const forWire = ({ data: _data, ...rest }: BarcodeRead): WireBarcode => ({ ...rest, byteLength: rest.text.length });

export async function read(): Promise<ReadResult> {
  const open = held();
  phase = "scanning";
  tell();

  try {
    if (mock) applyArmedOutcome();
    const result = await open.readDocument();
    phase = "idle";
    tell();

    // Which layout, and whether it verified — never the fields themselves.
    if (result.mrz.recognized) {
      const layout = result.mrz.fields?.format ?? "unrecognised layout";
      const checks = result.mrz.fields ? (result.mrz.fields.allChecksValid ? "check digits valid" : "CHECK DIGITS FAILED") : "not parsed";
      const partial = result.mrz.hasUnclassifiedCharacters ? ", with unclassified characters" : "";
      log(result.mrz.fields?.allChecksValid ? "ok" : "error", `MRZ read — ${layout}, ${checks}${partial}`);
    }
    else {
      log("info", "No MRZ found on the document");
    }

    if (result.barcode.found) log("ok", `Barcode read — ${result.barcode.symbology}, ${result.barcode.data.length} bytes`);

    return { mrz: result.mrz, barcode: forWire(result.barcode) };
  }
  catch (err) {
    phase = "idle";
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * Retrieve an image of the last scan.
 *
 * The bytes go straight to the caller in the response. They are never written to disk: the image
 * is the printed page of somebody's passport, portrait included.
 */
export async function image(light: LightSourceName, format: ImageFormat): Promise<DocumentImage> {
  const open = held();
  if (mock && mockLib) mockLib.state.imageBytes = syntheticScan(light);
  // The mock synthesises BMP and nothing else, so asking it for JPEG would return BMP bytes
  // labelled as JPEG. Forcing the format keeps what the page renders honest.
  const wanted = mock ? "bmp" : format;
  const scan = await open.image(light, { format: wanted, region: "document" });
  log("info", `Image — ${light}, ${scan.format}, ${scan.bytes.length} bytes`);
  return scan;
}

export async function setLed(color: LedColorName | "off"): Promise<void> {
  const open = held();
  const next: LedColorName = color === "off" ? "black" : color;
  await open.setStatusLed({
    enabled: color !== "off",
    color: next,
    usage: "permanent",
    durationMs: 0,
    highTimeMs: 0,
    lowTimeMs: 0,
  });
  await open.useStatusLed(color !== "off");
  led = color;
  tell();
  log("sent", `Status LED ${color}`);
}

export async function buzz(): Promise<void> {
  const open = held();
  await open.setBuzzer({ enabled: true, durationMs: 300, highTimeMs: 150, lowTimeMs: 150 });
  await open.useBuzzer();
  log("sent", "Buzzer");
}

// ---------------------------------------------------------------------------------------------
// Mock arming
// ---------------------------------------------------------------------------------------------

let armed: NextOutcome = "passport";

/** Arm what the mock scanner will produce next. The page offers this only when mocking. */
export function arm(outcome: NextOutcome): void {
  if (!mock || !mockLib) throw new Error("Only a mock scanner can be armed");
  armed = outcome;
  log("info", `Mock armed: ${outcome}`);
}

/** Put the armed outcome into the mock's device state, just before the read reaches it. */
function applyArmedOutcome(): void {
  const device = mockState();
  const barcode = { symbology: "]C", payload: new TextEncoder().encode(DEMO_BARCODE) };
  switch (armed) {
    case "passport":
      device.mrzLines = DEMO_MRZ;
      device.barcode = undefined;
      break;
    case "smudged":
      device.mrzLines = SMUDGED_MRZ;
      device.barcode = undefined;
      break;
    case "noDocument":
      device.mrzLines = [];
      device.barcode = undefined;
      break;
    case "barcodeOnly":
      device.mrzLines = [];
      device.barcode = barcode;
      break;
  }
}

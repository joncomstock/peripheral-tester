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

import { LedColor, LightSource, Resolution } from "@eai/desko/penta";
import type {
  BarcodeRead,
  DocumentImage,
  ImageFormat,
  ImageRegion,
  LedColorName,
  LedUsageName,
  LightSourceName,
  MrzRead,
  ReadMrzOptions,
  ResolutionName,
} from "@eai/desko/penta";
/**
 * The bench subpath, not the device one.
 *
 * `@eai/desko/penta` carries the scanner a kiosk should hold: connect, the settings, the LED, the
 * buzzer, and `readDocument`, which takes the scan and both recognitions under one driver lock.
 * `scan`, `readMrz`, `readBarcode` and `image` are on `DeskoPentaBench` instead, because each reads
 * the DLL's *process-global* "last scan" and a workflow that composes them can pair one document's
 * MRZ with another's photograph. This tester wants them anyway, and for the reason the split names:
 * someone standing at the machine needs to know which step failed, so `Read document` is the safe
 * sequence and the other three are the same calls one at a time. The public raw-symbol constructor
 * and the mock live on the same subpath.
 */
import { createMockPageScanLib, DeskoPentaBench } from "@eai/desko/penta/bench";
import type { MockPageScan } from "@eai/desko/penta/bench";
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

let penta: DeskoPentaBench | null = null;
let mockLib: MockPageScan | null = null;
let status: Status = "closed";
let phase: Phase = "idle";
let mock = false;
let dllPath: string | undefined;
let led: LedColorName | "off" = "off";
let ledUsage: LedUsageName = "permanent";
let buzzerMs = 300;
/**
 * Whether a scan is being held for the read calls to interpret.
 *
 * The API keeps one scan for the whole process and it lives only until the next one, so a
 * `readMrz` with `source: "pc"` against nothing held reads whatever was there before — or nothing.
 * Tracking it lets the page say which of those it is instead of showing an empty result.
 */
let scanned = false;
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
/** The vendor recommends this whenever document cropping follows, which here it always does. */
let ambientLightElimination = true;
/**
 * Where MRZ recognition runs.
 *
 * A tester-side preference rather than a device setting: it selects which pair of API calls a read
 * makes (`ReadOcrPc` over the held infrared scan, or `ReadOcrDevice` over what the unit's own OCR
 * produced), so it is passed per call rather than configured on the device.
 */
let mrzSource: NonNullable<ReadMrzOptions["source"]> = "pc";

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

/**
 * What the driver accepts, read from the driver rather than listed here.
 *
 * The light board does the same and the README says why: nothing in this repo keeps its own list,
 * so it cannot disagree with the driver about what the device has. A source added to `@eai/desko`
 * reaches the page without either side being edited.
 *
 * `undefined` is dropped from the resolutions: it is the vendor's "not specified" value, not a
 * setting anyone chooses, and the header guarantees only the other three.
 *
 * `black` is dropped from the LED colours for the same kind of reason: it is how the vendor spells
 * "off", which the page offers as its own control, so listing it would put the same command on two
 * buttons.
 */
export const vocabulary = () => ({
  lights: Object.keys(LightSource) as LightSourceName[],
  resolutions: (Object.keys(Resolution) as ResolutionName[]).filter((r) => r !== "undefined"),
  ledColors: (Object.keys(LedColor) as LedColorName[]).filter((c) => c !== "black"),
});

export const state = () => ({
  status,
  vocabulary: vocabulary(),
  phase,
  mock,
  led,
  ledUsage,
  buzzerMs,
  scanned,
  documentPresent,
  settings: { lights: [...lights], resolution, ambientLightElimination, source: mrzSource },
  api,
  device,
});

const tell = () => announce("passportreader", state());

/** The mock's device state, so the page can arm what the next read produces. */
function mockState(): MockPageScan["state"] {
  if (!mockLib) throw new Error("Only a mock scanner can be armed");
  return mockLib.state;
}

/**
 * The mock symbol table the driver ships, rather than a second imitation of the device.
 *
 * `@eai/desko` exports the fake `PageScanAPI.dll` its own tests run against, so `--mock` exercises
 * the real struct packing and the real MRZ and barcode decoding. A mock written here would drift
 * the moment the driver was corrected.
 */
const mockPageScanLib = (): MockPageScan => createMockPageScanLib({ mrzLines: DEMO_MRZ, imageBytes: syntheticScan("visible") });

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  tell();
  log("info", mock ? "Opening mock scanner" : "Opening PENTA over the FullPage API");

  try {
    if (mock) {
      mockLib = mockPageScanLib();
      penta = new DeskoPentaBench(mockLib.symbols, { scanSettings: scanSettings() });
    }
    else {
      penta = DeskoPentaBench.open({ dllPath, scanSettings: scanSettings() });
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
  scanned = false;
  documentPresent = null;
  api = undefined;
  device = undefined;
  stopPresencePolling();
  await open.close();
  tell();
  log("info", "Scanner released");
}

function held(): DeskoPentaBench {
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

/** The scan settings as the driver takes them, in one place so connect and a change cannot differ. */
const scanSettings = () => ({ lights, resolution, ambientLightElimination });

export async function settings(
  next: {
    lights?: LightSourceName[];
    resolution?: ResolutionName;
    ambientLightElimination?: boolean;
    source?: NonNullable<ReadMrzOptions["source"]>;
    buzzerMs?: number;
  },
): Promise<void> {
  // What the scan is exposed under, before anything is applied. Compared against afterwards rather
  // than testing which fields the request *named*: a refused light set and a re-press of the
  // already-selected resolution both name a field without moving anything, and reacting to those
  // discarded a held scan and made a native `SetScanSettingsEx` round trip for no change at all.
  const before = JSON.stringify(scanSettings());
  if (next.source !== undefined) mrzSource = next.source;
  // A scan with no light at all exposes nothing, so an empty set keeps what was there.
  if (next.lights !== undefined && next.lights.length > 0) lights = next.lights;
  // `ReadOcrPc` reads specifically the infrared image, so infrared is not optional while the OCR
  // runs on the PC — a set without it arms a read that cannot recognise anything. `ReadOcrDevice`
  // needs no scan, so the same set is legitimate there, and refusing it outright made half of the
  // source choice untestable.
  //
  // Satisfied here rather than refused, and applied to the set as it ends up rather than to the
  // one that was asked for: the two used to be separate steps, so a request that both moved the
  // OCR to the PC and dropped infrared was repaired and then refused, which reached the right
  // answer by a route nobody could follow. Enforced on the server as well as in the page because
  // the route is reachable without it, and the failure it prevents is a silent `recognized: false`
  // with nothing saying why.
  if (mrzSource === "pc" && !lights.includes("ir")) {
    lights = ["ir", ...lights];
    log("info", "Infrared kept on — ReadOcrPc reads the infrared scan");
  }
  if (next.resolution !== undefined) resolution = next.resolution;
  if (next.ambientLightElimination !== undefined) ambientLightElimination = next.ambientLightElimination;
  // A held scan was exposed under the *previous* illumination, so it no longer answers for these.
  // The OCR source is deliberately not one of them: it selects which pair of native calls the next
  // read makes and is passed per call, so it says nothing about the scan already being held — but
  // re-enabling infrared above does change the illumination, so that counts, which is why this
  // compares the settings themselves rather than which of them the request mentioned.
  const scanChanged = JSON.stringify(scanSettings()) !== before;
  if (scanChanged) scanned = false;
  if (next.buzzerMs !== undefined) buzzerMs = Math.min(2000, Math.max(50, Math.round(next.buzzerMs)));
  // Only when a scan setting actually moved. `SetScanSettingsEx` is a native round trip, and the
  // buzzer's − / + stepper would otherwise make one per press for a value the scan never reads.
  if (penta && scanChanged) await penta.setScanSettings(scanSettings());
  tell();
  log(
    "info",
    `Scan: ${lights.join(" + ")} @ ${resolution}${ambientLightElimination ? ", ambient light elimination on" : ""}` +
      ` · OCR on the ${mrzSource === "pc" ? "PC" : "device"} · buzzer ${buzzerMs} ms`,
  );
}

/**
 * Re-initialise the device without dropping the connection.
 *
 * The scan settings go back on afterwards: a reset returns the unit to its own defaults, and a page
 * still showing the settings it was driving would then be describing a device that is not obeying
 * them.
 */
export async function reset(): Promise<void> {
  const open = held();
  await open.reset();
  scanned = false;
  await open.setScanSettings(scanSettings());
  tell();
  log("info", "Device reset — connection kept, scan settings re-applied");
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
  /**
   * The payload as hex, for a barcode carrying bytes rather than characters.
   *
   * `text` cannot stand in for it: the driver renders through windows-1252, so `0x80`-`0x9F` decode
   * to code points outside the byte range and cannot be read back. The vendor header warns the
   * payload may be any binary, and a tester that can only show mojibake for one is a tester that
   * cannot diagnose it. Only sent when the text is not plainly printable, so a boarding pass — which
   * is ASCII — does not carry a second copy of itself.
   */
  hex?: string;
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
  /** How long the driver took, measured here. The page shows it beside the presentation. */
  ms: number;
}

/**
 * Time one driver call.
 *
 * Measured around the driver rather than in the browser: a full-page scan is a USB transfer plus an
 * OCR pass, and how long *that* took is the number worth showing — a round trip over loopback would
 * fold this process's own scheduling into it.
 */
async function timed<T>(work: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = performance.now();
  const result = await work();
  return { result, ms: Math.round(performance.now() - started) };
}

/**
 * A barcode, shaped for the wire.
 *
 * Spread rather than respelled field by field, so a field added to the driver's `BarcodeRead`
 * reaches the page instead of being silently dropped here.
 *
 * The count is taken from `data`, not from `text.length`. Those happen to be equal — the driver
 * yields one code point per byte — but that is a decoding choice in another package, and a byte
 * count depending on it would start reporting characters the day it changed.
 *
 * `data` itself does not cross: a `Uint8Array` serialises as an object of numeric keys, which is
 * neither the bytes nor useful. `hex` carries them instead when the text alone would not.
 */
export const forWire = ({ data, ...rest }: BarcodeRead): WireBarcode => ({
  ...rest,
  byteLength: data.length,
  ...(isPlainText(rest.text) ? {} : { hex: [...data].map((b) => b.toString(16).padStart(2, "0")).join(" ") }),
});

/** Printable ASCII plus tab, newline and carriage return — what a boarding pass is made of. */
const isPlainText = (text: string) => /^[\t\n\r\x20-\x7e]*$/.test(text);

export async function read(): Promise<ReadResult> {
  const open = held();
  phase = "scanning";
  // Dropped before the attempt, not after it. Whatever the driver was holding stops answering the
  // moment the device is asked to expose again, so a scan that then fails leaves nothing held —
  // and reporting one would have `Retrieve` encode the document *before* the one that failed.
  scanned = false;
  tell();

  try {
    if (mock) applyArmedOutcome();
    const { result, ms } = await timed(() => open.readDocument({ source: mrzSource }));
    // `readDocument` scans under one lock before it recognises, so a scan is held afterwards.
    scanned = true;
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

    return { mrz: result.mrz, barcode: forWire(result.barcode), ms };
  }
  catch (err) {
    phase = "idle";
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * Expose the document, and hold the result.
 *
 * The granular half of {@link read}. Separate calls are what the API actually offers and what a
 * tester wants: a scan that produces an image but no MRZ, and a recognition that fails on a scan
 * that was fine, are different faults, and one combined button cannot tell them apart.
 *
 * The scan is process-wide and lives only until the next one, which is why {@link read} exists —
 * it holds the driver's lock across the scan and the recognition so the pairing is guaranteed.
 */
export async function scan(): Promise<{ ms: number }> {
  const open = held();
  phase = "scanning";
  // See `read()`: the held scan is gone the moment the device is asked for a new one.
  scanned = false;
  tell();
  let elapsed = 0;
  try {
    if (mock) applyArmedOutcome();
    const { ms } = await timed(() => open.scan());
    elapsed = ms;
    scanned = true;
  }
  finally {
    phase = "idle";
    tell();
  }
  log("info", `Scan — ${lights.join(" + ")} @ ${resolution}`);
  return { ms: elapsed };
}

/**
 * Recognise the MRZ of whatever is held, without scanning again.
 *
 * **Refuses when the OCR runs on the PC and no scan is held.** `ReadOcrPc` reads the infrared
 * image the API is holding, and neither it nor the driver checks whether that image is from this
 * document — so against nothing held it returns the *previous* traveller's name, number and date
 * of birth, rendered under the current presentation. That is the same stale-buffer fault the image
 * path had, with a worse payload, and this is the one caller that was left out of the fix.
 *
 * `ReadOcrDevice` needs no scan: it returns what the unit's own OCR produced as the document
 * passed, so it is not gated.
 */
export async function readMrz(): Promise<{ mrz: MrzRead; ms: number }> {
  const open = held();
  if (mrzSource === "pc" && !scanned) {
    throw new Error("No scan held — ReadOcrPc reads the last infrared scan, which is another document's. Scan first.");
  }
  const { result: mrz, ms } = await timed(() => open.readMrz({ source: mrzSource }));
  // Which layout, and whether it verified — never the fields themselves.
  if (!mrz.recognized) log("info", `No MRZ recognised (${mrzSource === "pc" ? "ReadOcrPc" : "ReadOcrDevice"})`);
  else {
    const layout = mrz.fields?.format ?? "unrecognised layout";
    const checks = mrz.fields ? (mrz.fields.allChecksValid ? "check digits valid" : "CHECK DIGITS FAILED") : "not parsed";
    log(mrz.fields?.allChecksValid ? "ok" : "error", `MRZ read — ${layout}, ${checks}`);
  }
  return { mrz, ms };
}

/** Fetch whatever the device decoded as documents passed the window since the last read. */
export async function readBarcode(): Promise<{ barcode: WireBarcode; ms: number }> {
  const { result: barcode, ms } = await timed(() => held().readBarcode());
  if (barcode.found) log("ok", `Barcode read — ${barcode.symbology}, ${barcode.data.length} bytes`);
  else log("info", "No barcode decoded since the last read");
  return { barcode: forWire(barcode), ms };
}

/**
 * Retrieve an image of the last scan.
 *
 * The bytes go straight to the caller in the response. They are never written to disk: the image
 * is the printed page of somebody's passport, portrait included.
 */
export async function image(light: LightSourceName, format: ImageFormat, region: ImageRegion): Promise<DocumentImage> {
  const open = held();
  if (mock && mockLib) mockLib.state.imageBytes = syntheticScan(light);
  // The mock synthesises BMP and nothing else, so asking it for JPEG would return BMP bytes
  // labelled as JPEG. Forcing the format keeps what the page renders honest.
  const wanted = mock ? "bmp" : format;
  const encoded = await open.image(light, { format: wanted, region });
  log("info", `Image — ${region}, ${light}, ${encoded.format}, ${encoded.bytes.length} bytes`);
  return encoded;
}

/** Milliseconds lit and dark per cycle when the LED is flashing. Ignored while it is permanent. */
const FLASH_MS = 400;

export async function setLed(color: LedColorName | "off", usage?: LedUsageName): Promise<void> {
  const open = held();
  if (usage !== undefined) ledUsage = usage;
  const next: LedColorName = color === "off" ? "black" : color;
  const flashing = ledUsage === "flashing";
  await open.setStatusLed({
    enabled: color !== "off",
    color: next,
    usage: ledUsage,
    // Zero never lapses, which is what a tester wants: a setting that timed out on its own would
    // look like the device dropping it.
    durationMs: 0,
    highTimeMs: flashing ? FLASH_MS : 0,
    lowTimeMs: flashing ? FLASH_MS : 0,
  });
  await open.useStatusLed(color !== "off");
  led = color;
  tell();
  log("sent", `Status LED ${color}${color === "off" ? "" : ` · ${ledUsage}`}`);
}

/**
 * Sound the buzzer for the configured duration.
 *
 * The duration is a setting, changed through {@link settings}. Folding the two together made the
 * page's − / + stepper sound the buzzer on every press, which is not what changing a number means.
 */
export async function buzz(): Promise<void> {
  const open = held();
  const half = Math.round(buzzerMs / 2);
  await open.setBuzzer({ enabled: true, durationMs: buzzerMs, highTimeMs: half, lowTimeMs: half });
  await open.useBuzzer();
  log("sent", `Buzzer — ${buzzerMs} ms`);
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

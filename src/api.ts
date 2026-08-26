/**
 * Typed client for the tester backend's JSON + SSE API.
 *
 * Nothing here talks to hardware. Every peripheral is held by `server/`, which owns the COM handle
 * and the USB HID handle; only the process holding them can drive the devices.
 *
 * The types mirror each driver, but the *values* deliberately do not: section names, actions,
 * channel numbers and track masks all arrive from the backend, which builds them from the drivers'
 * own exported vocabularies. A copy of them here would recreate exactly the drift those drivers'
 * designs avoid.
 */

// ---- shared ---------------------------------------------------------------------------------

export type Device = "system" | "lightboard" | "cardreader" | "passportreader";
export type Status = "closed" | "opening" | "open";

export interface LogEntry {
  at: string;
  device: Device;
  kind: string;
  text: string;
}

// ---- light board ----------------------------------------------------------------------------

export type Action = "on" | "off" | "blink";
export type IndicatorSection =
  | "payment"
  | "cardReader"
  | "passportReader"
  | "boardingPassPrinter"
  | "gppDispenser";
export type StripPrimary = "green" | "red" | "blue";
/** The three wired channels, plus the additive mixes of them the strip can be asked for. */
export type StripColor = StripPrimary | "cyan" | "magenta" | "yellow" | "white";
export type SemaphoreColor = "green" | "red" | "yellow";
export type Side = "left" | "right";
export type Door = "upper" | "lower";

/** Mirrors the driver's `LedRequest` union, including the strip's missing `blink`. */
export type LedRequest =
  | { readonly section: IndicatorSection; readonly action: Action }
  | { readonly section: "bagTagPrinter"; readonly action: Action; readonly side: Side }
  | { readonly section: "semaphore"; readonly action: Action; readonly color: SemaphoreColor }
  | { readonly section: "strip"; readonly action: "on" | "off"; readonly color: StripColor };

export interface Claimant {
  id: string;
  label: string;
}

export interface Collision {
  channel: number;
  claimants: Claimant[];
}

export interface Vocabulary {
  actions: Action[];
  indicators: { section: IndicatorSection; channel: number }[];
  sides: { side: Side; channel: number }[];
  stripColors: { color: StripColor; primaries: StripPrimary[]; channels: number[] }[];
  semaphoreColors: { color: SemaphoreColor; channels: number[] }[];
  doorChannels: { channel: number; door: Door }[];
  collisions: Collision[];
}

export interface LightBoardState {
  status: Status;
  portName: string;
  mock: boolean;
  doors: Record<Door, string>;
  vocabulary: Vocabulary;
}

// ---- card reader ----------------------------------------------------------------------------

export type ReadDirection = "none" | "insertion" | "back";
export type LedColor = "green" | "red" | "orange";
export type ReadPhase = "idle" | "waiting" | "reading";
/** What the mock reader will do next. Offered only when mocking. */
export type NextOutcome = "card" | "timeout" | "unreadable";
/**
 * Whether the shutter is holding a card.
 *
 * The device does not report this, so it is what was last commanded — on real hardware the card in
 * the slot is the authority.
 */
export type Shutter = "locked" | "unlocked";
/**
 * Who drives the bezel LED. In `automatic` the reader lights it from its own state, and asking for a
 * colour competes with that — which reads as an indicator that does not work.
 */
export type LedControlMode = "manual" | "automatic";

export interface TransactionSetting {
  direction: ReadDirection;
  /** Bitmask: 1 track 1, 2 track 2, 4 track 3. */
  tracks: number;
  insertionLock: boolean;
  pullOutLock: boolean;
}

export interface CardReaderState {
  status: Status;
  /** The interface the driver claims, as the backend read it from the driver. */
  usb: { vendorId: number; productId: number };
  /** What the driver accepts, as the backend read it from the driver — never a copy of it. */
  vocabulary: { ledColors: LedColor[] };
  phase: ReadPhase;
  mock: boolean;
  led: LedColor | "off";
  ledBlinking: boolean;
  ledMode: LedControlMode;
  shutter: Shutter;
  listening: boolean;
  /** A listened-for card is held server-side until collected. The stream never carries the card. */
  cardWaiting: boolean;
  /** Unidentified literals the driver considers safe to try. Probing is limited to these. */
  candidates: readonly string[];
  seconds: number;
  transaction: TransactionSetting;
  /** What these settings put on the wire, so the page can show what it is sending. */
  literals: { prepare: string; monitor: string; read: string; lock: string; unlock: string; led: string };
}

export interface Track1 {
  pan: string;
  surname: string;
  firstName?: string;
  nameRest?: string;
  expiry?: string;
  serviceCode?: string;
  discretionary?: string;
}

export interface Track2 {
  pan: string;
  expiry?: string;
  serviceCode?: string;
  discretionary?: string;
}

/**
 * A read card.
 *
 * **Carries an unmasked PAN and the raw stripe.** It exists only in the reply to the read that
 * produced it — the backend never records it, and the page masks it unless asked. Do not put any of
 * this into the activity log, a URL, or storage.
 */
export interface CardData {
  track1?: Track1;
  track2?: Track2;
  pan?: string;
  expiry?: string;
  surname?: string;
  firstName?: string;
  raw: string;
}

export interface ReadResult {
  ok: boolean;
  kind?: "card" | "timeout" | "cancelled" | "readFailed";
  card?: CardData;
  status?: string;
  error?: string;
}

// ---- passport reader ------------------------------------------------------------------------

export type LightSource = "ir" | "visible" | "uv" | "uv3led";
/**
 * The resolutions a caller may select.
 *
 * The driver's own `Resolution` also carries the vendor's `undefined` member, which is "not
 * specified" rather than a choice — the backend leaves it out of the served vocabulary and refuses
 * it, so naming it here would describe a value nothing accepts.
 */
export type ScanResolution = "low" | "default" | "high";
export type ScanPhase = "idle" | "scanning";
/** Which part of the scan window an image covers. */
export type ImageRegion = "full" | "document";
/** Where MRZ recognition runs — on the PC over the held infrared scan, or on the unit itself. */
export type OcrSource = "pc" | "device";
export type LedUsage = "permanent" | "flashing";
export type StatusLedColor = "black" | "red" | "green" | "yellow" | "blue" | "purple" | "turquoise" | "white";
/** What the mock scanner will produce next. Offered only when mocking. */
export type NextScan = "passport" | "smudged" | "noDocument" | "barcodeOnly";

export interface PassportReaderState {
  status: Status;
  /**
   * What the driver accepts, as the backend read it from the driver.
   *
   * Values rather than a copy of them, for the reason this file's header gives: a list written here
   * would be free to disagree with the device.
   */
  vocabulary: { lights: LightSource[]; resolutions: ScanResolution[]; ledColors: StatusLedColor[] };
  phase: ScanPhase;
  mock: boolean;
  led: StatusLedColor | "off";
  ledUsage: LedUsage;
  buzzerMs: number;
  /**
   * Whether a scan is held for the read calls to interpret.
   *
   * The API keeps one scan per process and it lives only until the next, so `ReadOcrPc` against
   * nothing held reads whatever was there before. This is what lets the page say which it is.
   */
  scanned: boolean;
  /** `null` when the device has not been asked, or cannot answer — not the same as "no document". */
  documentPresent: boolean | null;
  settings: {
    lights: LightSource[];
    resolution: ScanResolution;
    ambientLightElimination: boolean;
    source: OcrSource;
  };
  api?: { version: number; number: number; dllVersion: string; compileDate: string };
  device?: {
    deviceType: string;
    vendorId: number;
    productId: number;
    firmware: string;
    /** Which optional features this unit actually has, as the device reports them. */
    capabilities: Record<string, boolean>;
  };
}

/** A date as it appears in an MRZ, alongside its interpretation. */
export interface MrzDate {
  raw: string;
  iso?: string;
}

/** One check digit, and whether the data it covers agrees with it. */
export interface MrzCheck {
  digit: string;
  valid: boolean;
}

/**
 * Fields decoded from a recognised MRZ.
 *
 * **This is personal data** — a name, a nationality, a date of birth and a document number. It
 * exists only in the reply to the read that produced it. The backend never records it, and the page
 * masks it unless asked. Do not put any of it into the activity log, a URL, or storage.
 */
export interface MrzFields {
  format: "TD1" | "TD2" | "TD3" | "MRVA" | "MRVB";
  documentCode: string;
  issuingState: string;
  surname: string;
  givenNames: string;
  documentNumber: string;
  nationality: string;
  dateOfBirth: MrzDate;
  sex: "M" | "F" | "X";
  dateOfExpiry: MrzDate;
  optionalData: string;
  optionalData2: string;
  checks: {
    documentNumber: MrzCheck;
    dateOfBirth: MrzCheck;
    dateOfExpiry: MrzCheck;
    optionalData?: MrzCheck;
    composite?: MrzCheck;
  };
  allChecksValid: boolean;
}

/** One MRZ read. Carries the same personal data as {@link MrzFields}; the same rules apply. */
export interface MrzRead {
  recognized: boolean;
  lines: string[];
  raw: string;
  /** True when the OCR could not classify a glyph. The read is still returned. */
  hasUnclassifiedCharacters: boolean;
  source: "pc" | "device";
  fields?: MrzFields;
}

/** A barcode as the backend sends it — the driver's own `BarcodeRead` carries bytes, which do not
 *  survive JSON, so the decoded text and the length cross instead. */
export interface WireBarcode {
  found: boolean;
  /** Present when the payload is not plainly printable — the bytes, so binary is still diagnosable. */
  hex?: string;
  symbology: string;
  symbologyCode: string;
  text: string;
  byteLength: number;
}

export interface ScanResult {
  ok: boolean;
  mrz?: MrzRead;
  barcode?: WireBarcode;
  /** How long the driver took, measured around the call by the backend rather than round-trip. */
  ms: number;
  error?: string;
}

// ---- snapshot + events ----------------------------------------------------------------------

export interface Snapshot {
  mock: boolean;
  log: LogEntry[];
  lightboard: LightBoardState;
  cardreader: CardReaderState;
  passportreader: PassportReaderState;
}

export type Event =
  /**
   * Sent on every connection, including the silent reconnects `EventSource` makes on its own.
   * Carries a whole snapshot, so a client that has been away can replace what it holds rather than
   * trying to work out what it missed.
   */
  | ({ type: "hello" } & Snapshot)
  | { type: "log"; entry: LogEntry }
  | { type: "state"; device: "lightboard"; state: Omit<LightBoardState, "vocabulary"> }
  | { type: "state"; device: "cardreader"; state: CardReaderState }
  | { type: "state"; device: "passportreader"; state: PassportReaderState };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} answered ${response.status} ${response.statusText}`);
  return await response.json() as T;
}

export const getSnapshot = () => getJson<Snapshot>("/api/state");

/** Posts a command and returns the body, so callers that need a result can read one. */
async function post<T = { ok: boolean }>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(payload?.error ?? `${response.status} ${response.statusText}`);
  return payload as T;
}

export const lightboard = {
  connect: (portName: string) => post("/api/lightboard/connect", { portName }),
  disconnect: () => post("/api/lightboard/disconnect"),
  led: (request: LedRequest) => post("/api/lightboard/led", request),
  allOff: () => post("/api/lightboard/all-off"),
  simulateDoor: (door: Door) => post("/api/lightboard/door", { door }),
};

export const cardreader = {
  connect: () => post("/api/cardreader/connect"),
  disconnect: () => post("/api/cardreader/disconnect"),
  reset: () => post("/api/cardreader/reset"),
  clear: () => post("/api/cardreader/clear"),
  settings: (next: Partial<TransactionSetting> & { seconds?: number }) => post("/api/cardreader/settings", next),
  led: (color: LedColor | "off", blink?: boolean) => post("/api/cardreader/led", { color, blink }),
  read: () => post<ReadResult>("/api/cardreader/read"),
  cancel: () => post("/api/cardreader/cancel"),
  /** Drive the shutter now, as opposed to the transaction's locks, which arm the next read. */
  shutter: (shutter: Shutter) => post("/api/cardreader/shutter", { shutter }),
  ledMode: (mode: LedControlMode) => post("/api/cardreader/led-mode", { mode }),
  listen: () => post("/api/cardreader/listen"),
  stopListening: () => post("/api/cardreader/stop"),
  takeCard: () => post<{ ok: boolean; card: CardData | null }>("/api/cardreader/take-card"),
  identity: () => post<{ ok: boolean; version: string; serialNumber: string; status: string }>("/api/cardreader/identity"),
  deactivateIcc: () => post("/api/cardreader/deactivate-icc"),
  probe: (literal: string) => post<{ ok: boolean; literal: string; token: string; accepted: boolean }>("/api/cardreader/probe", { literal }),
  arm: (outcome: NextOutcome) => post("/api/cardreader/arm", { outcome }),
};

export const passportreader = {
  connect: () => post("/api/passportreader/connect"),
  disconnect: () => post("/api/passportreader/disconnect"),
  /** Re-initialise the unit without dropping the connection. The scan settings go back on after. */
  reset: () => post("/api/passportreader/reset"),
  settings: (
    next: {
      lights?: LightSource[];
      resolution?: ScanResolution;
      ambientLightElimination?: boolean;
      source?: OcrSource;
      buzzerMs?: number;
    },
  ) => post("/api/passportreader/settings", next),
  led: (color: StatusLedColor | "off", usage?: LedUsage) => post("/api/passportreader/led", { color, usage }),
  /** Sounds the buzzer for its configured duration. The duration itself is a setting. */
  buzz: () => post("/api/passportreader/buzz"),
  read: () => post<ScanResult>("/api/passportreader/read"),
  /** Expose the document and hold the result, without recognising it. */
  scan: () => post<{ ms: number }>("/api/passportreader/scan"),
  /** Recognise the MRZ of whatever is held. Carries document data; treated like {@link read}. */
  mrz: () => post<{ mrz: MrzRead; ms: number }>("/api/passportreader/mrz"),
  /** Whatever the device decoded as documents passed the window since the last read. */
  barcode: () => post<{ barcode: WireBarcode; ms: number }>("/api/passportreader/barcode"),
  arm: (outcome: NextScan) => post("/api/passportreader/arm", { outcome }),
  /**
   * URL for the scanned page under one light source.
   *
   * A URL rather than a fetch, so an `<img>` can render it directly. The cache-buster is what makes
   * a second read replace the picture: without it the browser would show the previous document,
   * because the address is otherwise identical. The encoding is the backend's to choose — no
   * control here offers one, and under mock it can only produce BMP whatever is asked.
   */
  imageUrl: (light: LightSource, region: ImageRegion, nonce: number) =>
    `/api/passportreader/image?light=${light}&region=${region}&n=${nonce}`,
};

/** Subscribes to the event stream, which carries every device at once. Returns an unsubscribe. */
export function subscribe(onEvent: (event: Event) => void, onDropped: (message: string) => void): () => void {
  const stream = new EventSource("/api/events");
  stream.onmessage = (message) => onEvent(JSON.parse(message.data) as Event);
  stream.onerror = () => onDropped("Event stream dropped — is the backend still running?");
  return () => stream.close();
}

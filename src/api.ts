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

export interface TransactionSetting {
  direction: ReadDirection;
  /** Bitmask: 1 track 1, 2 track 2, 4 track 3. */
  tracks: number;
  insertionLock: boolean;
  pullOutLock: boolean;
}

export interface CardReaderState {
  status: Status;
  phase: ReadPhase;
  mock: boolean;
  led: LedColor | "off";
  seconds: number;
  transaction: TransactionSetting;
  /** What these settings put on the wire, so the page can show what it is sending. */
  literals: { prepare: string; monitor: string; read: string };
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
  vocabulary: { lights: LightSource[]; resolutions: ScanResolution[] };
  phase: ScanPhase;
  mock: boolean;
  led: StatusLedColor | "off";
  /** `null` when the device has not been asked, or cannot answer — not the same as "no document". */
  documentPresent: boolean | null;
  settings: { lights: LightSource[]; resolution: ScanResolution };
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
  led: (color: LedColor | "off") => post("/api/cardreader/led", { color }),
  read: () => post<ReadResult>("/api/cardreader/read"),
  cancel: () => post("/api/cardreader/cancel"),
  arm: (outcome: NextOutcome) => post("/api/cardreader/arm", { outcome }),
};

export const passportreader = {
  connect: () => post("/api/passportreader/connect"),
  disconnect: () => post("/api/passportreader/disconnect"),
  settings: (next: { lights?: LightSource[]; resolution?: ScanResolution }) => post("/api/passportreader/settings", next),
  led: (color: StatusLedColor | "off") => post("/api/passportreader/led", { color }),
  buzz: () => post("/api/passportreader/buzz"),
  read: () => post<ScanResult>("/api/passportreader/read"),
  arm: (outcome: NextScan) => post("/api/passportreader/arm", { outcome }),
  /**
   * URL for the scanned page under one light source.
   *
   * A URL rather than a fetch, so an `<img>` can render it directly. The cache-buster is what makes
   * a second read replace the picture: without it the browser would show the previous document,
   * because the address is otherwise identical. The encoding is the backend's to choose — no
   * control here offers one, and under mock it can only produce BMP whatever is asked.
   */
  imageUrl: (light: LightSource, nonce: number) => `/api/passportreader/image?light=${light}&n=${nonce}`,
};

/** Subscribes to the event stream, which carries every device at once. Returns an unsubscribe. */
export function subscribe(onEvent: (event: Event) => void, onDropped: (message: string) => void): () => void {
  const stream = new EventSource("/api/events");
  stream.onmessage = (message) => onEvent(JSON.parse(message.data) as Event);
  stream.onerror = () => onDropped("Event stream dropped — is the backend still running?");
  return () => stream.close();
}

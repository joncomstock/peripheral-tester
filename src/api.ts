/**
 * Typed client for the tester backend's JSON + SSE API.
 *
 * Nothing here talks to hardware. Every peripheral is held by `server/`, which owns the USB and USB
 * HID handles; only the process holding them can drive the devices.
 *
 * The types mirror each driver, but the *values* deliberately do not: section names, actions,
 * channel numbers and track masks all arrive from the backend, which builds them from the drivers'
 * own exported vocabularies. A copy of them here would recreate exactly the drift those drivers'
 * designs avoid.
 */

// ---- shared ---------------------------------------------------------------------------------

export type Device = "system" | "lightboard" | "cardreader" | "sankyo" | "penta" | "xpm" | "storm" | "honeywell" | "itk38" | "adr300" | "idtech" | "datalogic" | "custom" | "k8" | "allpixel" | "embross";
export type Status = "closed" | "opening" | "open";

/** The fields every device's state carries, whatever else it holds. */
export interface BaseState {
  status: Status;
  mock: boolean;
  /** The USB vendor:product the driver opens, or how else it is reached. */
  usbId: string;
}

/** A device's slice of the snapshot, for code that only needs what every device shares. */
export const stateOf = (snapshot: Snapshot, id: Exclude<Device, "system">): BaseState | undefined =>
  (snapshot as unknown as Record<string, BaseState | undefined>)[id];

/**
 * Commands for any device: connect, disconnect, and its own actions at `/api/<device>/<action>`.
 * The first four devices also have the typed clients below.
 */
export const device = (id: Exclude<Device, "system">) => ({
  connect: () => post(`/api/${id}/connect`),
  disconnect: () => post(`/api/${id}/disconnect`),
  act: <T = { ok: boolean }>(action: string, body?: unknown) => post<T>(`/api/${id}/${action}`, body),
});

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
  /** The USB vendor:product the driver opens. */
  usbId: string;
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
  phase: ReadPhase;
  mock: boolean;
  usbId: string;
  led: LedColor | "off";
  ledBlinking: boolean;
  ledMode: LedControlMode;
  listening: boolean;
  /** A card is in the slot, as the listen loop last polled. Only known while listening. */
  present: boolean;
  /** The bezel's colours, from the driver. */
  ledColors: LedColor[];
  /** Who can drive the bezel LED, from the driver. */
  ledModes: LedControlMode[];
  /** A listened-for card is held server-side until collected. The stream never carries the card. */
  cardWaiting: boolean;
  seconds: number;
  transaction: TransactionSetting;
  /** What these settings put on the wire, so the page can show what it is sending. */
  literals: { prepare: string; monitor: string; read: string };
}

/** One track as read: its characters, and the ISO 7813 fields when they parsed. */
export interface Track<Fields = never> {
  raw: string;
  fields?: Fields;
}

/**
 * A read card, in the shape both card reader drivers share.
 *
 * **Carries an unmasked PAN and the raw stripe.** It exists only in the reply to the read that
 * produced it — the backend never records it, and the page masks it unless asked. Do not put any of
 * this into the activity log, a URL, or storage.
 */
export interface CardData {
  /** `name` is as encoded: `SURNAME/FIRST`, space-padded. Expiry is `YYMM`. */
  track1?: Track<{ pan: string; name: string; expiry: string }>;
  track2?: Track<{ pan: string; expiry: string }>;
  track3?: Track;
}

export interface ReadResult {
  ok: boolean;
  kind?: "card" | "timeout" | "cancelled" | "readFailed";
  card?: CardData;
  status?: string;
  error?: string;
}

// ---- Sankyo card reader ---------------------------------------------------------------------

export type SankyoLedColor = "off" | "red" | "green" | "yellow";

export interface SankyoState {
  status: Status;
  mock: boolean;
  usbId: string;
  /** An Intake is waiting for a card. */
  reading: boolean;
  listening: boolean;
  /** A card is in the slot, as the monitor last polled. Only known while listening. */
  present: boolean;
  /** Whether the mock's card is in its slot. */
  mockInserted: boolean;
  cardWaiting: boolean;
  led: SankyoLedColor;
  /** The bezel's colours, from the driver, `off` included. */
  ledColors: SankyoLedColor[];
  seconds: number;
}

// ---- DESKO Penta ------------------------------------------------------------------------------

export type PentaSimulation = "place" | "boarding-pass" | "flip" | "remove";

export interface PentaState {
  status: Status;
  mock: boolean;
  usbId: string;
  /** The last document event. Edge-triggered: null until the first one after connecting. */
  document: "present" | "flipped" | "removed" | null;
  /** The last decode. A boarding pass carries a passenger's name: shown here, never logged. */
  barcode: { symbology: string | null; text: string } | null;
  /** What was last commanded; the device does not report its LEDs. */
  statusLed: { mode: "on" | "flash"; color: string } | null;
  externalLed: string;
  /** 0 is off; the driver's steps up to `floodLevels`. Null until read. */
  floodLevel: number | null;
  floodLevels: number;
  /** The driver's own vocabularies. */
  ledColors: string[];
  externalLedColors: string[];
}

// ---- snapshot + events ----------------------------------------------------------------------

export interface Snapshot {
  /** Every device is simulated. Switched from the Settings panel. */
  mock: boolean;
  /** The backend may open real devices (it has FFI permission). Without it, mock is the only mode. */
  hardwareAllowed: boolean;
  log: LogEntry[];
  lightboard: LightBoardState;
  cardreader: CardReaderState;
  sankyo: SankyoState;
  penta: PentaState;
}

export type Event =
  /**
   * Sent on every connection, including the silent reconnects `EventSource` makes on its own.
   * Carries a whole snapshot, so a client that has been away can replace what it holds rather than
   * trying to work out what it missed.
   */
  | ({ type: "hello" } & Snapshot)
  | { type: "log"; entry: LogEntry }
  | { type: "mode"; mock: boolean }
  | { type: "state"; device: "lightboard"; state: Omit<LightBoardState, "vocabulary"> }
  | { type: "state"; device: "cardreader"; state: CardReaderState }
  | { type: "state"; device: "sankyo"; state: SankyoState }
  | { type: "state"; device: "penta"; state: PentaState }
  | { type: "state"; device: Exclude<Device, "system" | "lightboard" | "cardreader" | "sankyo" | "penta">; state: BaseState };

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

export const settings = {
  /** Switching disconnects every device first. */
  mock: (on: boolean) => post("/api/settings/mock", { on }),
};

/** Darken and release every connected device. */
export const disconnectAll = () => post("/api/disconnect-all");

export const lightboard = {
  connect: () => post("/api/lightboard/connect"),
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
  ledMode: (mode: LedControlMode) => post("/api/cardreader/led-mode", { mode }),
  listen: () => post("/api/cardreader/listen"),
  stopListening: () => post("/api/cardreader/stop"),
  takeCard: () => post<{ ok: boolean; card: CardData | null }>("/api/cardreader/take-card"),
  identity: () => post<{ ok: boolean; version: string; serialNumber: string; status: string }>("/api/cardreader/identity"),
  arm: (outcome: NextOutcome) => post("/api/cardreader/arm", { outcome }),
};

export const sankyo = {
  connect: () => post("/api/sankyo/connect"),
  disconnect: () => post("/api/sankyo/disconnect"),
  seconds: (seconds: number) => post("/api/sankyo/seconds", { seconds }),
  led: (color: SankyoLedColor, blink: boolean) => post("/api/sankyo/led", { color, blink }),
  read: () => post<ReadResult>("/api/sankyo/read"),
  cancel: () => post("/api/sankyo/cancel"),
  listen: () => post("/api/sankyo/listen"),
  stopListening: () => post("/api/sankyo/stop"),
  takeCard: () => post<{ ok: boolean; card: CardData | null }>("/api/sankyo/take-card"),
  identity: () => post<{ ok: boolean; deviceName: string; serialNumber: string; revision: string }>("/api/sankyo/identity"),
  simulateCard: (inserted: boolean) => post("/api/sankyo/card", { inserted }),
};

export const penta = {
  connect: () => post("/api/penta/connect"),
  disconnect: () => post("/api/penta/disconnect"),
  statusLed: (mode: "on" | "flash" | "off", color?: string) => post("/api/penta/status-led", { mode, color }),
  externalLed: (color: string) => post("/api/penta/external-led", { color }),
  beep: () => post("/api/penta/beep"),
  flood: (level: number) => post("/api/penta/flood", { level }),
  identity: () => post<{ ok: boolean; firmware: string; build: string; engine: string }>("/api/penta/identity"),
  simulate: (action: PentaSimulation) => post("/api/penta/simulate", { action }),
};

/** Subscribes to the event stream, which carries every device at once. Returns an unsubscribe. */
export function subscribe(onEvent: (event: Event) => void, onDropped: (message: string) => void): () => void {
  const stream = new EventSource("/api/events");
  stream.onmessage = (message) => onEvent(JSON.parse(message.data) as Event);
  stream.onerror = () => onDropped("Event stream dropped — is the backend still running?");
  return () => stream.close();
}

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

export type Device = "system" | "lightboard" | "cardreader";
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
  phase: ReadPhase;
  mock: boolean;
  led: LedColor | "off";
  ledBlinking: boolean;
  ledMode: LedControlMode;
  shutter: Shutter;
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

// ---- snapshot + events ----------------------------------------------------------------------

export interface Snapshot {
  mock: boolean;
  log: LogEntry[];
  lightboard: LightBoardState;
  cardreader: CardReaderState;
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
  | { type: "state"; device: "cardreader"; state: CardReaderState };

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
  shutter: (shutter: Shutter) => post("/api/cardreader/shutter", { shutter }),
  ledMode: (mode: LedControlMode) => post("/api/cardreader/led-mode", { mode }),
  arm: (outcome: NextOutcome) => post("/api/cardreader/arm", { outcome }),
};

/** Subscribes to the event stream, which carries every device at once. Returns an unsubscribe. */
export function subscribe(onEvent: (event: Event) => void, onDropped: (message: string) => void): () => void {
  const stream = new EventSource("/api/events");
  stream.onmessage = (message) => onEvent(JSON.parse(message.data) as Event);
  stream.onerror = () => onDropped("Event stream dropped — is the backend still running?");
  return () => stream.close();
}

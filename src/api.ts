/**
 * Typed client for the tester backend's JSON + SSE API.
 *
 * Nothing here talks to hardware. The board is driven by `server/main.ts`, which holds the COM
 * handle — only the process holding it can drive the board.
 *
 * The types mirror `@eai/ier/s33380`, but the *values* deliberately do not: section names, actions
 * and channel numbers all arrive from the backend, which builds them from the driver's own exported
 * vocabularies and live channel map. A copy of them here would recreate exactly the drift the
 * driver's design avoids.
 *
 * There is no mock in the browser either, for the same reason. `deno task dev:mock` runs a fake
 * `Transport` through the *real* driver, so the command construction, framing and ack matching being
 * exercised are the shipped ones. A second mock on this side would be a copy that can go stale.
 */

// ---- Mirrored driver types -----------------------------------------------------------------

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

/** Mirrors the driver's `LedRequest` discriminated union, including the strip's missing `blink`. */
export type LedRequest =
  | { readonly section: IndicatorSection; readonly action: Action }
  | { readonly section: "bagTagPrinter"; readonly action: Action; readonly side: Side }
  | { readonly section: "semaphore"; readonly action: Action; readonly color: SemaphoreColor }
  | { readonly section: "strip"; readonly action: "on" | "off"; readonly color: StripColor };

// ---- Wire shapes ---------------------------------------------------------------------------

export type Status = "closed" | "opening" | "open";

/** One line of the backend's activity log. `kind` is open-ended: the driver may add kinds. */
export interface LogEntry {
  at: string;
  kind: string;
  text: string;
}

/**
 * One section addressing a channel.
 *
 * `id` is the claimant's identity in the driver's vocabulary and is the same scheme controls are
 * keyed by, so a collision can be tied back to the control it concerns. `label` is for reading.
 */
export interface Claimant {
  id: string;
  label: string;
}

export interface Collision {
  channel: number;
  claimants: Claimant[];
}

/** The driver's own vocabularies plus the channel map in force. */
export interface Vocabulary {
  mock: boolean;
  actions: Action[];
  indicators: { section: IndicatorSection; channel: number }[];
  sides: { side: Side; channel: number }[];
  stripColors: { color: StripColor; primaries: StripPrimary[]; channels: number[] }[];
  semaphoreColors: { color: SemaphoreColor; channels: number[] }[];
  doorChannels: { channel: number; door: Door }[];
  collisions: Collision[];
}

export interface State {
  status: Status;
  portName: string;
  mock: boolean;
  doors: Record<Door, string>;
  log: LogEntry[];
  vocabulary: Vocabulary;
}

/** Pushed over SSE: either a new log line or a change of connection or door state. */
export type Event =
  | { type: "log"; entry: LogEntry }
  | { type: "status"; status: Status; portName: string; doors: Record<Door, string> };

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} answered ${response.status} ${response.statusText}`);
  return await response.json() as T;
}

export const getState = () => getJson<State>("/api/state");

/**
 * Posts a command.
 *
 * The backend records both the send and any board-side failure in its own log, which streams back,
 * so the caller only has to surface what that log will never show: a request that did not arrive.
 */
async function post(path: string, body?: unknown): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.ok) return;
  const failure = await response.json().catch(() => null) as { error?: string } | null;
  throw new Error(failure?.error ?? `${response.status} ${response.statusText}`);
}

export const connect = (portName: string) => post("/api/connect", { portName });
export const disconnect = () => post("/api/disconnect");
export const sendLed = (request: LedRequest) => post("/api/led", request);
export const sendAllOff = () => post("/api/all-off");
export const simulateDoor = (door: Door) => post("/api/door", { door });

/** Subscribes to the event stream. Returns an unsubscribe. */
export function subscribe(onEvent: (event: Event) => void, onDropped: (message: string) => void): () => void {
  const stream = new EventSource("/api/events");
  stream.onmessage = (message) => onEvent(JSON.parse(message.data) as Event);
  stream.onerror = () => onDropped("Event stream dropped — is the backend still running?");
  return () => stream.close();
}

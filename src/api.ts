/**
 * Typed client for the tester backend's JSON + SSE API.
 *
 * Nothing here talks to hardware. The board is driven by `server/main.ts`, which holds the COM
 * handle — only the process holding it can drive the board.
 *
 * The types mirror `@eai/ier/s33380`, but the *values* deliberately do not: section names, actions
 * and channel numbers all arrive from `/api/vocabulary`, which the backend builds from the driver's
 * own exported vocabularies and the live channel map. A copy of them here would recreate exactly the
 * drift the driver's design avoids.
 *
 * There is no mock in the browser either, for the same reason. `deno task dev:mock` runs a fake
 * `Transport` through the *real* driver, so the command construction, framing and ack matching being
 * exercised are the shipped ones. A second mock on this side would be a copy that can go stale, and
 * a page that can fake a board is a page that can produce a screenshot nobody should trust.
 */

// ---- Mirrored driver types -----------------------------------------------------------------

export type Action = "on" | "off" | "blink";
export type IndicatorSection =
  | "payment"
  | "cardReader"
  | "passportReader"
  | "boardingPassPrinter"
  | "gppDispenser";
export type StripColor = "green" | "red" | "blue";
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

/** One line of the backend's log. `kind` is open-ended: the driver may add kinds. */
export interface LogEntry {
  at: string;
  kind: string;
  text: string;
}

/** Indicator channels addressed by more than one section, computed from the live map. */
export interface Collision {
  channel: number;
  labels: string[];
}

/** `/api/vocabulary` — the driver's own vocabularies plus the channel map of the wired board. */
export interface Vocabulary {
  portName: string;
  /** True when a fake transport is in use. The page must say so, unmissably. */
  mock: boolean;
  actions: Action[];
  indicators: { section: IndicatorSection; channel: number }[];
  sides: { side: Side; channel: number }[];
  stripColors: { color: StripColor; channel: number }[];
  semaphoreColors: { color: SemaphoreColor; channels: number[] }[];
  collisions: Collision[];
  /** Sections whose channel the driver has never confirmed against hardware. */
  unverified: string[];
}

/** `/api/status` — the authoritative door state, so the UI never parses it out of a log line. */
export interface Status {
  listening: boolean;
  doors: Record<Door, string>;
  log: LogEntry[];
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} answered ${response.status} ${response.statusText}`);
  return await response.json() as T;
}

export const getVocabulary = () => getJson<Vocabulary>("/api/vocabulary");
export const getStatus = () => getJson<Status>("/api/status");

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

export const sendLed = (request: LedRequest) => post("/api/led", request);
export const sendAllOff = () => post("/api/all-off");

/** Subscribes to the log stream. Returns an unsubscribe. */
export function subscribe(
  onEntry: (entry: LogEntry) => void,
  onDropped: (message: string) => void,
): () => void {
  const stream = new EventSource("/api/events");
  stream.onmessage = (event) => {
    const entry = JSON.parse(event.data) as LogEntry;
    if (entry.kind !== "hello") onEntry(entry);
  };
  stream.onerror = () => onDropped("event stream dropped — is the backend still running?");
  return () => stream.close();
}

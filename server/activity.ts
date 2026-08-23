/**
 * The activity log and the event stream, shared by every device.
 *
 * One log rather than one per device, tagged with which device produced each line: an operator
 * working through a kiosk moves between peripherals, and the order things happened in is the thing
 * worth preserving. The page filters by device when it is showing one.
 *
 * **Nothing here may carry cardholder or document data.** The card reader's driver returns an
 * unmasked PAN and says nothing above it should log the PAN or the raw stripe; the passport
 * reader's returns an MRZ, which is a name, a nationality, a date of birth and a document number.
 * This module is the "above it" for both, so the rule lands here. That content goes to the page in
 * a response and is never recorded.
 *
 * @module
 */

/** Which peripheral a line came from. `system` is the tester talking about itself. */
export type Device = "system" | "lightboard" | "cardreader" | "passportreader";

export interface Entry {
  at: string;
  device: Device;
  /** Open-ended: a driver may add kinds, and the page tones what it recognises. */
  kind: string;
  text: string;
}

/** Bounded so a long session cannot grow without end. */
const MAX_ENTRIES = 500;

const entries: Entry[] = [];
const listeners = new Set<(line: string) => void>();

function push(payload: unknown): void {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const listener of listeners) listener(line);
}

export function record(device: Device, kind: string, text: string): void {
  const entry: Entry = { at: new Date().toISOString().slice(11, 19), device, kind, text };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  push({ type: "log", entry });
}

/** Broadcast a device's changed state. The shape is the device's own; the page routes on `device`. */
export function announce(device: Device, state: unknown): void {
  push({ type: "state", device, state });
}

export const history = (): Entry[] => [...entries];

export function subscribe(send: (line: string) => void): () => void {
  listeners.add(send);
  return () => listeners.delete(send);
}

/** Server-sent events for every device at once, newest arriving as they happen. */
export function eventStream(hello: () => unknown): Response {
  let send: (line: string) => void;
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      send = (line) => {
        try {
          controller.enqueue(encoder.encode(line));
        }
        catch {
          listeners.delete(send);
        }
      };
      listeners.add(send);
      send(`data: ${JSON.stringify(hello())}\n\n`);
    },
    cancel() {
      listeners.delete(send);
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

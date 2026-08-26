/**
 * The health sweep: open every wired device, confirm it answers, and put it back.
 *
 * A real handshake, not a probe of a table — it is the same `connect` the device screens use, so a
 * pass means the handle was genuinely claimed and the device genuinely replied. Nothing is driven:
 * no lamp is lit, no card is read, no document is scanned.
 *
 * A device the operator already has open is left open and reported from its live state. Opening it
 * again would mean closing it first, which would darken a board somebody is watching.
 */

import * as api from "./api.ts";
import type { Snapshot } from "./api.ts";
import type { WiredId } from "./devices.ts";
import { isLive } from "./devices.ts";
import { clockTime } from "./format.ts";

export interface SweepResult {
  pass: boolean;
  detail: string;
  /** Wall-clock of the attempt, so a stale pass is visibly stale. */
  at: string;
}

export type SweepResults = Partial<Record<WiredId, SweepResult>>;

const CONNECT: Record<WiredId, (snapshot: Snapshot) => Promise<unknown>> = {
  lightboard: (snapshot) => api.lightboard.connect(snapshot.lightboard?.portName ?? ""),
  cardreader: () => api.cardreader.connect(),
  passportreader: () => api.passportreader.connect(),
};

const DISCONNECT: Record<WiredId, () => Promise<unknown>> = {
  lightboard: () => api.lightboard.disconnect(),
  cardreader: () => api.cardreader.disconnect(),
  passportreader: () => api.passportreader.disconnect(),
};

/**
 * What a device that answered has to say for itself, read back after it opened.
 *
 * Keyed like `CONNECT` and `DISCONNECT` beside it, so all three per-device tables have one shape
 * and adding a fourth device means adding a row to each rather than finding three cascades.
 */
const DETAIL: Record<WiredId, (snapshot: Snapshot) => string> = {
  lightboard: (snapshot) => `Handshake acknowledged on ${snapshot.lightboard?.portName ?? "—"}`,
  cardreader: () => "Interface claimed, reader answered",
  passportreader: (snapshot) => {
    const device = snapshot.passportreader?.device;
    return device
      ? `Reported ${device.deviceType}, firmware ${device.firmware}, API ${snapshot.passportreader?.api?.dllVersion ?? "—"}`
      : "Library loaded and the device answered";
  },
};

/**
 * Handshake one device.
 *
 * Never throws: a refusal is the result, not an exception — a sweep that stopped at the first
 * broken device would tell you least about the kiosk you most need to know about.
 */
export async function handshake(id: WiredId, snapshot: Snapshot): Promise<SweepResult> {
  // Refused before it is attempted: the backend has no driver for this device in its checkout, so
  // there is nothing to claim and the reason is a branch, not the hardware.
  const absent = snapshot.absent[id];
  if (absent !== undefined) return { pass: false, detail: `No driver in this checkout — ${absent}`, at: clockTime() };

  if (isLive(snapshot, id)) return { pass: true, detail: `${DETAIL[id](snapshot)} — already open, left open`, at: clockTime() };

  if (id === "lightboard" && (snapshot.lightboard?.portName ?? "").trim() === "") {
    return { pass: false, detail: "No port set", at: clockTime() };
  }

  try {
    await CONNECT[id](snapshot);
    // Read back rather than assume: what the device said about itself is the point of the sweep.
    const opened = await api.getSnapshot();
    const detail = DETAIL[id](opened);
    await DISCONNECT[id]();
    return { pass: true, detail, at: clockTime() };
  }
  catch (err) {
    // A half-open handle would block the operator's own connect afterwards.
    await DISCONNECT[id]().catch(() => {});
    return { pass: false, detail: err instanceof Error ? err.message : String(err), at: clockTime() };
  }
}

/**
 * Handshake each of these devices in turn, reporting each as it lands.
 *
 * Given the ids rather than reading `WIRED`, because the sweep claims handles for real: a bench
 * testing only the light board should not have this open the card reader it deliberately left off
 * the rail. What it sweeps is what the rail shows.
 *
 * In turn rather than at once: they share nothing electrically, but they do share this process's
 * attention, and a sweep whose lamps all flicker together tells an operator nothing about which
 * device is slow.
 */
export async function runSweep(
  ids: WiredId[],
  snapshot: () => Snapshot,
  onResult: (id: WiredId, result: SweepResult) => void,
  onActive: (id: WiredId | null) => void,
): Promise<void> {
  for (const id of ids) {
    onActive(id);
    onResult(id, await handshake(id, snapshot()));
  }
  onActive(null);
}

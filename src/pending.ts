import { useCallback, useState } from "react";

/**
 * Dispatching a command to a device, and saying so while it is in the air.
 *
 * A setting on either reader is not applied optimistically: the page posts it, the backend drives
 * the device, and the new value arrives back over the event stream. That round trip is invisible,
 * so on anything slower than a loopback the control simply did not move — which reads as a dead
 * click, and the operator presses it again.
 *
 * Keyed by control rather than a single flag: two settings can be in flight at once, and dimming
 * a whole panel because one of them is would be worse than saying nothing.
 *
 * The light board uses it for only two commands — "All off" and the door simulation. Its lamps
 * are drawn from what was commanded, so every other control there has already moved by the time
 * the post returns and a marker on each would be noise.
 *
 * Both readers had their own byte-identical copy of this wiring. It lives here so a control that
 * grows a busy state on one screen cannot quietly lack one on the other.
 */
/**
 * The counter's one rule, as a pure function so it can be checked without a renderer.
 *
 * Extracted rather than left inline: it is the whole of what makes the marker honest, and testing
 * it through the hook would have meant a React test renderer and a DOM — two dependencies for one
 * arithmetic rule.
 */
export function stepPending(
  previous: ReadonlyMap<string, number>,
  key: string,
  by: 1 | -1,
): ReadonlyMap<string, number> {
  const next = new Map(previous);
  const count = (next.get(key) ?? 0) + by;
  if (count > 0) next.set(key, count);
  else next.delete(key);
  return next;
}

export function useCommands(enabled: boolean, onFail: (message: string) => void) {
  /**
   * How many commands are in flight per key, not merely whether any is.
   *
   * A group's buttons share a key — the two door switches, the eight LED colours — so pressing one
   * and then another puts two in flight at once. Counted, the marker clears when the last settles;
   * as a set it cleared when the *first* did, and the control went back to looking idle while it
   * was still working. That is the dead click this exists to remove, in miniature.
   */
  const [pending, setPending] = useState<ReadonlyMap<string, number>>(() => new Map());

  const step = useCallback((key: string, by: 1 | -1) => setPending((previous) => stepPending(previous, key, by)), []);

  /** Post a command, mark `key` busy until it settles, and report a refusal. */
  const send = useCallback((key: string, work: Promise<unknown>): Promise<unknown> => {
    step(key, 1);
    return work.catch((err: Error) => onFail(err.message)).finally(() => step(key, -1));
  }, [step, onFail]);

  /** Props for a segmented group: enabled state and whether it is waiting on the device. */
  const seg = useCallback((key: string) => ({
    className: "seg",
    "data-enabled": enabled,
    "aria-busy": pending.has(key) || undefined,
  }), [enabled, pending]);

  /**
   * The same for a control that is not a group.
   *
   * The shutter, the buzzer and the LED picker all round-trip through the device and none of them
   * is a segmented control, so a marker that only understood groups left exactly those three
   * looking like dead clicks — the case it was added for.
   */
  const busy = useCallback((key: string) => ({ "aria-busy": pending.has(key) || undefined }), [pending]);

  return { send, seg, busy };
}

import { describe, expect, it } from "vitest";
import { stepPending } from "./pending.ts";

/** Apply a run of steps to an empty counter, the way `send` and its `finally` would. */
const run = (...steps: [string, 1 | -1][]) =>
  steps.reduce<ReadonlyMap<string, number>>((counts, [key, by]) => stepPending(counts, key, by), new Map());

describe("counting commands in flight", () => {
  it("marks a key while one command is in the air, and clears it after", () => {
    expect(run(["led", 1]).has("led")).toBe(true);
    expect(run(["led", 1], ["led", -1]).has("led")).toBe(false);
  });

  /**
   * The behaviour the counter exists for.
   *
   * A group's buttons share one key — the two door switches, the eight LED colours — so two can be
   * in flight at once. Held as a set, the first to settle cleared the marker and the control went
   * back to looking idle while it was still working: the dead click this exists to remove.
   */
  it("stays marked until the last of two commands on one key settles", () => {
    expect(run(["door", 1], ["door", 1], ["door", -1]).has("door")).toBe(true);
    expect(run(["door", 1], ["door", 1], ["door", -1], ["door", -1]).has("door")).toBe(false);
  });

  it("marks only the key that was sent", () => {
    const counts = run(["tracks", 1]);
    expect(counts.has("tracks")).toBe(true);
    expect(counts.has("direction")).toBe(false);
  });

  it("never goes negative, so a stray settle cannot make the next command unmarkable", () => {
    const stray = run(["shutter", -1]);
    expect(stray.has("shutter")).toBe(false);
    expect(stepPending(stray, "shutter", 1).get("shutter")).toBe(1);
  });

  it("leaves the previous map alone, so React sees a new value every time", () => {
    const before = run(["led", 1]);
    const after = stepPending(before, "led", 1);
    expect(before.get("led")).toBe(1);
    expect(after.get("led")).toBe(2);
    expect(after).not.toBe(before);
  });
});

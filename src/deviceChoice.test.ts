import { describe, expect, it } from "vitest";
import type { DeviceId } from "./devices.ts";
import { DEFAULT_DEVICES, DEVICES, KIOSKS, kioskOf, toggleDevice } from "./devices.ts";

/**
 * The two rules the device picker rests on: what a selection *is*, and what it may become.
 *
 * The rest of the picker is rendering. These are the parts that can be silently wrong — a preset
 * that names a device the catalogue dropped, or a toggle that empties a rail nothing can draw.
 */
describe("the catalogue", () => {
  it("has no two devices under one id, which the rail keys rows by", () => {
    expect(new Set(DEVICES.map((entry) => entry.id)).size).toBe(DEVICES.length);
  });

  it("gives every kiosk at least one device this repo has a driver for", () => {
    for (const kiosk of KIOSKS) expect(kiosk.devices.length, kiosk.name).toBeGreaterThan(0);
  });

  it("names only devices the catalogue still has, in every preset", () => {
    const known = new Set(DEVICES.map((entry) => entry.id));
    for (const kiosk of KIOSKS) {
      for (const id of kiosk.devices) expect(known, `${kiosk.name} → ${id}`).toContain(id);
    }
  });

  /**
   * A copy, not the preset's own array. Exported by reference it becomes React state, and an edit
   * to that state would be an edit to the catalogue every other bench reads.
   */
  it("keeps the default set clear of the preset it was taken from", () => {
    expect(DEFAULT_DEVICES).toEqual(KIOSKS[0].devices);
    expect(DEFAULT_DEVICES).not.toBe(KIOSKS[0].devices);
  });

  it("opens on a kiosk that carries all three devices with a screen", () => {
    const wired = DEVICES.filter((entry) => entry.ready).map((entry) => entry.id);
    expect(DEFAULT_DEVICES).toEqual(expect.arrayContaining(wired));
  });
});

describe("naming a selection", () => {
  it("recognises a preset whatever order it was ticked in", () => {
    expect(kioskOf([...KIOSKS[0].devices].reverse())?.id).toBe(KIOSKS[0].id);
  });

  it("is custom once a preset has one device too many", () => {
    const extra = DEVICES.find((entry) => !KIOSKS[0].devices.includes(entry.id));
    expect(kioskOf([...KIOSKS[0].devices, extra!.id])).toBeNull();
  });

  it("is custom once a preset has one device too few", () => {
    expect(kioskOf(KIOSKS[0].devices.slice(1))).toBeNull();
  });

  /**
   * The length check is what makes this true. Comparing only "every preset device is selected"
   * would call a superset of the 919 a 919, and the dropdown would then say IER 919 over a rail
   * carrying somebody else's scanner.
   */
  it("is custom for a superset of a preset", () => {
    expect(kioskOf(DEVICES.map((entry) => entry.id))).toBeNull();
  });
});

describe("toggling a device", () => {
  const some: DeviceId[] = ["lightboard", "cardreader"];

  it("removes one that was on", () => {
    expect(toggleDevice(some, "cardreader")).toEqual(["lightboard"]);
  });

  it("adds one that was off", () => {
    expect(toggleDevice(some, "documentreader")).toContain("documentreader");
  });

  /**
   * Catalogue order, not click order, so the rail cannot be reordered by the order boxes were
   * ticked — and so `1`–`9` mean the same rows on the next visit as on this one.
   */
  it("keeps the result in catalogue order however it was built", () => {
    const built = toggleDevice(toggleDevice(["payment"], "lightboard"), "documentreader");
    const order = DEVICES.map((entry) => entry.id).filter((id) => built.includes(id));
    expect(built).toEqual(order);
  });

  /**
   * Refused by identity, which is how the picker knows to say so. An empty rail is a state this
   * app has no screen for — nothing to select, nothing to render — so it is refused here rather
   * than guarded for at every place the rail is read.
   */
  it("refuses to remove the last one, and says so by giving back the same array", () => {
    const only: DeviceId[] = ["lightboard"];
    expect(toggleDevice(only, "lightboard")).toBe(only);
  });

  it("still adds to a selection of one", () => {
    expect(toggleDevice(["lightboard"], "payment")).toEqual(["lightboard", "payment"]);
  });
});

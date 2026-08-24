import { describe, expect, it } from "vitest";
import { lightsFor } from "./PassportReaderPage.tsx";
import type { LightSource } from "./api.ts";

/**
 * What the backend serves, which it reads from the driver.
 *
 * These tests drive `lightsFor` with that list rather than a copy of it kept here, because a copy
 * is what the earlier version of this file got wrong: it compared one hand-written list against
 * another and would have stayed green while both drifted from the device.
 */
const FROM_DRIVER: LightSource[] = ["ir", "visible", "uv", "uv3led"];

const withUv = { uvLight: true, barcode: true };
const withoutUv = { uvLight: false, barcode: true };
const values = (caps: Record<string, boolean>) => lightsFor(FROM_DRIVER, caps).map((l) => l.value);

describe("light-source gating", () => {
  it("offers every source the driver reports when the lamp is fitted", () => {
    expect(values(withUv)).toEqual(FROM_DRIVER);
  });

  it("withholds both ultraviolet sources when the unit has no UV lamp", () => {
    // The behaviour, not the metadata: deleting the filter makes this fail.
    expect(values(withoutUv)).toEqual(["ir", "visible"]);
  });

  it("withholds them when the device reported no capabilities at all", () => {
    // A unit that has not answered yet must not be offered a lamp it may not have.
    expect(values({})).toEqual(["ir", "visible"]);
  });

  it("shows a source the driver grew but this page has no name for, rather than hiding it", () => {
    // The failure that let uv3led go missing: a source nothing here knows about must still appear.
    const unknown = "newSource" as LightSource;
    const grown = lightsFor([...FROM_DRIVER, unknown], withUv);
    expect(grown.map((l) => l.value)).toContain(unknown);
    expect(grown.find((l) => l.value === unknown)?.label).toBe(unknown);
  });

  it("names the sources it does know in words rather than identifiers", () => {
    for (const { value, label } of lightsFor(FROM_DRIVER, withUv)) expect(label).not.toBe(value);
  });
});

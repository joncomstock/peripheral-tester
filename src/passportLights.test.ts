import { describe, expect, it } from "vitest";
import { LIGHTS } from "./PassportReaderPage.tsx";
import type { LightSource } from "./api.ts";

/**
 * Every light source the driver accepts, spelled out.
 *
 * Written here rather than derived from `LightSource`, because a type cannot be enumerated at
 * runtime — and this list existing separately is the point: it fails when the driver grows a source
 * the page has not been taught, which is exactly how `uv3led` went missing.
 */
const EVERY_SOURCE: LightSource[] = ["ir", "visible", "uv", "uv3led"];

describe("the light-source controls", () => {
  it("offers every source the driver accepts", () => {
    expect(LIGHTS.map((l) => l.value).sort()).toEqual([...EVERY_SOURCE].sort());
  });

  it("gates both ultraviolet sources on the UV lamp, and neither of the others", () => {
    const needs = Object.fromEntries(LIGHTS.map((l) => [l.value, l.needs]));
    expect(needs.uv).toBe("uvLight");
    expect(needs.uv3led).toBe("uvLight");
    expect(needs.ir).toBeUndefined();
    expect(needs.visible).toBeUndefined();
  });

  it("labels each source in words rather than the driver's identifier", () => {
    for (const { value, label } of LIGHTS) expect(label).not.toBe(value);
  });
});

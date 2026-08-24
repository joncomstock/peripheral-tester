import { describe, expect, it } from "vitest";
import { maskStripe } from "./CardReaderPage.tsx";

/**
 * Track 1 running straight into track 2, which is how the device delivers them.
 *
 * The PAN is the standard 4111… test number, so nothing here resembles a real card.
 */
const ONE_PAN =
  "B4111111111111111^SANDOVAL/MARIA            ^29092010000002590000004111111111111111=29092010000259";

describe("masking the raw stripe", () => {
  it("blanks the PAN everywhere it appears, not only the first time", () => {
    const masked = maskStripe(ONE_PAN, ["4111111111111111"]);
    expect(masked).not.toContain("4111111111111111");
    expect(masked.length).toBe(ONE_PAN.length);
  });

  it("leaves the rest of the stripe readable, which is what it is shown for", () => {
    const masked = maskStripe(ONE_PAN, ["4111111111111111"]);
    expect(masked).toContain("SANDOVAL/MARIA");
    expect(masked).toContain("=2909");
  });

  /**
   * The case that cannot happen in mock mode, whose stripe encodes one PAN twice.
   *
   * `assembleCardData` reports `pan` as `track1?.pan ?? track2?.pan`, and the two are read from
   * separate buffers with no cross-check — `track2PanFrom` Luhn-picks its own suffix whenever the
   * digit run does not end with track 1's number. A misread on one track is exactly the fault this
   * screen exists to find, so it is the case the masking has to survive.
   */
  it("blanks both numbers when the two tracks disagree", () => {
    const divergent = "B4111111111111111^SANDOVAL/MARIA^2909201{}=29092010000259".replace("{}", "5555555555554444");
    const masked = maskStripe(divergent, ["4111111111111111", "4111111111111111", "5555555555554444"]);
    expect(masked).not.toContain("4111111111111111");
    expect(masked).not.toContain("5555555555554444");
  });

  it("ignores tracks that did not decode, rather than blanking the whole stripe", () => {
    expect(maskStripe(ONE_PAN, [undefined, undefined])).toBe(ONE_PAN);
    expect(maskStripe(ONE_PAN, ["", undefined])).toBe(ONE_PAN);
  });
});

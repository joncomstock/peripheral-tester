import { describe, expect, it } from "vitest";
import type { TransactionSetting } from "./api.ts";
import { CARD_SCENARIOS, incoherence } from "./cardScenarios.ts";

const setting = (over: Partial<TransactionSetting> = {}): TransactionSetting => ({
  direction: "insertion",
  tracks: 3,
  insertionLock: false,
  pullOutLock: false,
  ...over,
});

describe("incoherence", () => {
  it("passes a configuration that can read", () => {
    expect(incoherence(setting())).toBeNull();
  });

  /**
   * The deadlock this whole module exists to make unrepresentable: the card is captured on the way
   * in and held, so it never travels past the head on the way out and cannot be read. It reaches an
   * operator as "card present but unreadable" and a card stuck in the slot.
   */
  it("rejects holding on insertion while reading on withdrawal", () => {
    expect(incoherence(setting({ direction: "back", insertionLock: true })))
      .toMatch(/withdraw/i);
  });

  it("allows holding on insertion when the read happens on insertion", () => {
    expect(incoherence(setting({ direction: "insertion", insertionLock: true }))).toBeNull();
  });

  it("allows holding on withdrawal when the read happens on withdrawal", () => {
    expect(incoherence(setting({ direction: "back", pullOutLock: true }))).toBeNull();
  });

  it("rejects a read with no track selected", () => {
    expect(incoherence(setting({ tracks: 0 }))).toMatch(/track/i);
  });

  /** `@eai/omron`'s own note: the device refuses `none` in every capture taken. */
  it("rejects a direction the device refuses", () => {
    expect(incoherence(setting({ direction: "none" }))).toMatch(/direction/i);
  });
});

describe("CARD_SCENARIOS", () => {
  it("offers a scenario for each way a card can be read and held", () => {
    expect(CARD_SCENARIOS.map((s) => s.id)).toEqual([
      "insertion",
      "insertionRetain",
      "withdrawal",
      "withdrawalRetain",
    ]);
  });

  /**
   * The point of the whole module. A scenario that cannot possibly read has to fail the build
   * rather than eat a card at a bench.
   */
  it.each(CARD_SCENARIOS.map((s) => [s.id, s] as const))("%s is a configuration that can read", (_id, scenario) => {
    expect(incoherence(scenario.setting)).toBeNull();
  });

  it("asks for tracks 1 and 2, the driver's own default, and never track 3", () => {
    for (const scenario of CARD_SCENARIOS) expect(scenario.setting.tracks).toBe(3);
  });

  it("names which scenarios leave the card held, so the page can offer a release", () => {
    expect(CARD_SCENARIOS.filter((s) => s.retains).map((s) => s.id)).toEqual([
      "insertionRetain",
      "withdrawalRetain",
    ]);
  });
});

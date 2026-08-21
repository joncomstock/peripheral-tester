import { describe, expect, it } from "vitest";
import type { LogEntry, Vocabulary } from "./api.ts";
import { controlsFor, fullName, modeOf, nameOf, requestFor, towerMode } from "./rows.ts";
import { lampColor, stripPreviewStyle, toneOf } from "./look.ts";
import { phrase } from "./App.tsx";

/** Shaped like a real `/api/state` vocabulary, with the shipped channel map. */
const vocabulary: Vocabulary = {
  mock: false,
  actions: ["on", "off", "blink"],
  indicators: [
    { section: "payment", channel: 1 },
    { section: "cardReader", channel: 2 },
    { section: "passportReader", channel: 3 },
    { section: "boardingPassPrinter", channel: 4 },
    { section: "gppDispenser", channel: 5 },
  ],
  sides: [{ side: "left", channel: 8 }, { side: "right", channel: 9 }],
  stripColors: [
    { color: "green", primaries: ["green"], channels: [4] },
    { color: "red", primaries: ["red"], channels: [3] },
    { color: "blue", primaries: ["blue"], channels: [2] },
    { color: "cyan", primaries: ["green", "blue"], channels: [4, 2] },
    { color: "magenta", primaries: ["red", "blue"], channels: [3, 2] },
    { color: "yellow", primaries: ["green", "red"], channels: [4, 3] },
    { color: "white", primaries: ["green", "red", "blue"], channels: [4, 3, 2] },
  ],
  semaphoreColors: [
    { color: "green", channels: [1] },
    { color: "red", channels: [6] },
    { color: "yellow", channels: [6, 1] },
  ],
  doorChannels: [{ channel: 1, door: "upper" }, { channel: 3, door: "lower" }],
  collisions: [{
    channel: 1,
    claimants: [
      { id: "indicator:payment", label: "payment" },
      { id: "semaphore:green", label: "semaphore green" },
    ],
  }],
};

const controls = controlsFor(vocabulary);
const find = (key: string) =>
  [...controls.indicators, ...controls.bagTag, ...controls.semaphore, ...controls.strip]
    .find((control) => control.key === key)!;

describe("controlsFor", () => {
  it("never offers the strip a blink button", () => {
    // The strip's channels take Active/Inactive only. This is the constraint the driver's
    // discriminated union enforces at compile time, held here at runtime for the same reason.
    expect(find("strip:blue").actions).toEqual(["on", "off"]);
    expect(find("indicator:payment").actions).toEqual(["on", "off", "blink"]);
  });

  it("names a colour with every channel it lights", () => {
    // Yellow is red and green together on the tower, and cyan is green and blue on the strip; a
    // single channel would misdescribe what either drives.
    expect(find("semaphore:yellow").channel).toBe("6+1");
    expect(find("semaphore:green").channel).toBe("1");
    expect(find("strip:cyan").channel).toBe("4+2");
    expect(find("strip:white").channel).toBe("4+3+2");
  });

  it("offers the strip its mixes as well as its primaries", () => {
    expect(controls.strip.map((control) => control.label)).toEqual([
      "Green",
      "Red",
      "Blue",
      "Cyan",
      "Magenta",
      "Yellow",
      "White",
    ]);
    expect(find("strip:cyan").primaries).toEqual(["green", "blue"]);
  });

  it("gives operator-facing names but falls back to the driver's identifier", () => {
    expect(find("indicator:gppDispenser").label).toBe("GPP dispenser");
    expect(nameOf("somethingNewTheDriverGained")).toBe("somethingNewTheDriverGained");
  });

  it("gives every control an unambiguous accessible name", () => {
    // Both the semaphore and the strip have a green, so the bare label left two buttons on the page
    // with identical accessible names — indistinguishable to a screen reader.
    expect(find("semaphore:green").fullLabel).toBe("Semaphore green");
    expect(find("strip:green").fullLabel).toBe("Strip green");
    expect(find("bagTag:left").fullLabel).toBe("Bag tag left side");
    expect(find("indicator:payment").fullLabel).toBe("Payment terminal");

    const names = [...controls.indicators, ...controls.bagTag, ...controls.semaphore, ...controls.strip]
      .map((control) => control.fullLabel);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names a control and its activity line by one rule", () => {
    // The label on the button and the phrase in the log come from the same function, so a command
    // cannot be described two different ways on the same screen.
    expect(fullName("strip", "green")).toBe(find("strip:green").fullLabel);
  });

  it("derives its controls from the payload rather than a copy of the vocabulary", () => {
    const trimmed = controlsFor({ ...vocabulary, indicators: [{ section: "payment", channel: 7 }] });
    expect(trimmed.indicators).toHaveLength(1);
    expect(trimmed.indicators[0].channel).toBe("7");
  });
});

describe("requestFor", () => {
  it("builds each section's own request shape", () => {
    expect(requestFor({ section: "payment" }, "blink")).toEqual({ section: "payment", action: "blink" });
    expect(requestFor({ section: "bagTagPrinter", side: "left" }, "on"))
      .toEqual({ section: "bagTagPrinter", action: "on", side: "left" });
    expect(requestFor({ section: "semaphore", color: "yellow" }, "off"))
      .toEqual({ section: "semaphore", action: "off", color: "yellow" });
    expect(requestFor({ section: "strip", color: "blue" }, "on"))
      .toEqual({ section: "strip", action: "on", color: "blue" });
  });

  it("throws rather than quietly substituting a command for strip blink", () => {
    // A silent coercion to `off` would send a command the operator did not ask for while the
    // activity log claimed otherwise.
    expect(() => requestFor({ section: "strip", color: "blue" }, "blink")).toThrow(/no blink/);
  });
});

describe("towerMode", () => {
  it("is off until something is commanded", () => {
    expect(towerMode({}, "red")).toBe("off");
    expect(modeOf({}, "semaphore:red")).toBe("off");
  });

  it("lights both lamps for yellow, because yellow is both lamps", () => {
    const yellow = { "semaphore:yellow": "on" as const };
    expect(towerMode(yellow, "red")).toBe("on");
    expect(towerMode(yellow, "green")).toBe("on");
  });

  it("prefers a colour's own command over yellow's", () => {
    // Commanding red to blink after yellow was set on has to show red blinking, not steady.
    const mixed = { "semaphore:yellow": "on" as const, "semaphore:red": "blink" as const };
    expect(towerMode(mixed, "red")).toBe("blink");
    expect(towerMode(mixed, "green")).toBe("on");
  });
});

describe("stripPreviewStyle", () => {
  const mixes = vocabulary.stripColors;

  it("reads as unlit when nothing is on", () => {
    expect(stripPreviewStyle([], mixes).background).toContain("#eceef1");
  });

  it("shows the colour the strip actually mixes to", () => {
    // The 919 walk established the channels mix additively, so green and blue lit together is not
    // two bands — it is cyan, and the preview has to say so.
    expect(String(stripPreviewStyle(["green"], mixes).background)).toContain("#1f9d47");
    expect(String(stripPreviewStyle(["green", "blue"], mixes).background)).toContain("#12a6b8");
    expect(String(stripPreviewStyle(["red", "blue"], mixes).background)).toContain("#c33bb0");
    expect(String(stripPreviewStyle(["green", "red", "blue"], mixes).background)).toContain("#e9edf2");
  });

  it("does not care what order the primaries arrive in", () => {
    expect(stripPreviewStyle(["blue", "green"], mixes).background)
      .toEqual(stripPreviewStyle(["green", "blue"], mixes).background);
  });

  it("maps a colour name to the lamp it drives", () => {
    expect(lampColor("Blue")).toBe("#2d7ce0");
    expect(lampColor("Cyan")).toBe("#12a6b8");
  });
});

describe("phrase", () => {
  const sent = (request: unknown): LogEntry => ({ at: "", kind: "sent", text: JSON.stringify(request) });

  it("says what was commanded in the words the page uses", () => {
    expect(phrase(sent({ section: "gppDispenser", action: "on" }))).toBe("GPP dispenser — on");
    expect(phrase(sent({ section: "bagTagPrinter", action: "blink", side: "left" })))
      .toBe("Bag tag left side — blinking");
    expect(phrase(sent({ section: "semaphore", action: "off", color: "yellow" })))
      .toBe("Semaphore yellow — off");
    expect(phrase(sent({ section: "strip", action: "on", color: "blue" }))).toBe("Strip blue — on");
  });

  it("leaves anything the board said exactly as it arrived", () => {
    // The point of the activity log is that an unexpected reply is quoted, not paraphrased.
    const warned = { at: "", kind: "warned", text: "'AI;3=O' answered with 'AI;3=O@', expected 'AI@'" };
    expect(phrase(warned)).toBe(warned.text);
    expect(phrase({ at: "", kind: "ok", text: "All off" })).toBe("All off");
  });
});

describe("toneOf", () => {
  it("separates what failed from what merely happened", () => {
    expect(toneOf("error")).toBe("bad");
    expect(toneOf("failed")).toBe("bad");
    expect(toneOf("warned")).toBe("warn");
    expect(toneOf("ok")).toBe("ok");
    expect(toneOf("sent")).toBe("normal");
  });
});

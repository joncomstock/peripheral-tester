import { describe, expect, it } from "vitest";
import type { Vocabulary } from "./api.ts";
import { evidenceMarkdown, groupsFor, requestFor, tally } from "./rows.ts";

/** Shaped like a real `/api/vocabulary` payload, trimmed to a few rows per group. */
const vocabulary: Vocabulary = {
  portName: "COM14",
  mock: false,
  actions: ["on", "off", "blink"],
  indicators: [
    { section: "payment", channel: 1 },
    { section: "passportReader", channel: 3 },
    { section: "boardingPassPrinter", channel: 4 },
  ],
  sides: [{ side: "left", channel: 8 }],
  stripColors: [{ color: "green", channel: 4 }, { color: "blue", channel: 2 }],
  semaphoreColors: [{ color: "green", channels: [1] }, { color: "yellow", channels: [6, 1] }],
  collisions: [{ channel: 1, labels: ["payment", "semaphore green"] }],
  unverified: ["payment", "cardReader"],
};

const rows = () => groupsFor(vocabulary).flatMap((group) => group.rows);
const row = (key: string) => rows().find((candidate) => candidate.key === key)!;

describe("groupsFor", () => {
  it("never offers the strip a blink button", () => {
    // The strip's channels take Active/Inactive only. This is the constraint the driver's
    // discriminated union enforces at compile time, held here at runtime for the same reason.
    expect(row("strip:blue").actions).toEqual(["on", "off"]);
  });

  it("leaves every other section's actions as the driver sent them", () => {
    expect(row("indicator:payment").actions).toEqual(["on", "off", "blink"]);
    expect(row("semaphore:yellow").actions).toEqual(["on", "off", "blink"]);
  });

  it("addresses the strip in the AL space and everything else in AI", () => {
    expect(row("strip:blue").channels).toBe("AL;2");
    expect(row("indicator:passportReader").channels).toBe("AI;3");
    expect(row("bagTag:left").channels).toBe("AI;8");
    expect(row("semaphore:yellow").channels).toBe("AI;6 AI;1");
  });

  it("flags only the sections the backend reports as unverified", () => {
    expect(row("indicator:payment").unverified).toBe(true);
    expect(row("indicator:passportReader").unverified).toBe(false);
  });

  it("names each side of a shared pin on both rows", () => {
    // The clash is stated at the pin rather than in a banner, so both ends have to carry it.
    expect(row("indicator:payment").sharedWith).toEqual(["semaphore green"]);
    expect(row("semaphore:green").sharedWith).toEqual(["payment"]);
  });

  it("leaves a section off a shared pin unmarked", () => {
    expect(row("indicator:passportReader").sharedWith).toEqual([]);
    expect(row("semaphore:yellow").sharedWith).toEqual([]);
  });

  it("never marks a strip row as shared, whatever number it carries", () => {
    // strip green = 4 shares a number with boardingPassPrinter = 4, but AL and AI are separate
    // address spaces. A shared marker here would send the operator hunting a clash that cannot exist.
    expect(row("strip:green").channels).toBe("AL;4");
    expect(row("indicator:boardingPassPrinter").channels).toBe("AI;4");
    expect(row("strip:green").sharedWith).toEqual([]);
  });

  it("derives its rows from the payload rather than a copy of the vocabulary", () => {
    const extended = {
      ...vocabulary,
      indicators: [...vocabulary.indicators, { section: "gppDispenser" as const, channel: 5 }],
    };
    expect(groupsFor(extended)[0].rows.map((r) => r.label)).toEqual([
      "payment",
      "passportReader",
      "boardingPassPrinter",
      "gppDispenser",
    ]);
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
    // A silent coercion to `off` would send a command the operator did not ask for while the log
    // claimed otherwise — on the one tool whose whole purpose is trusting the log.
    expect(() => requestFor({ section: "strip", color: "blue" }, "blink")).toThrow(/no blink/);
  });
});

describe("tally", () => {
  it("counts every row, treating an unrecorded row as not checked", () => {
    const counts = tally(rows(), { "indicator:payment": { verdict: "astray", note: "" } });
    expect(counts).toEqual([
      { verdict: "untested", count: 7 },
      { verdict: "correct", count: 0 },
      { verdict: "astray", count: 1 },
      { verdict: "unlit", count: 0 },
    ]);
  });
});

describe("evidenceMarkdown", () => {
  const groups = groupsFor(vocabulary);
  const at = "2026-08-21T00:00:00.000Z";

  it("lists untested rows instead of dropping them", () => {
    const markdown = evidenceMarkdown(vocabulary, groups, {}, false, at);
    expect(markdown).toContain("- 8 not checked");
    expect(markdown.match(/Not checked/g)).toHaveLength(8);
  });

  it("resolves the lamp that lit instead into its own section and label", () => {
    // The pick is stored as a row key; the record has to read as prose a reviewer can follow.
    const markdown = evidenceMarkdown(
      vocabulary,
      groups,
      { "indicator:payment": { verdict: "astray", insteadOf: "semaphore:green", note: "very dim" } },
      false,
      at,
    );
    expect(markdown).toContain(
      "| Indicators / payment (driver: unverified) | `AI;1` | Wrong lamp | lit Semaphore / green instead; very dim |",
    );
    expect(markdown).toContain("- 7 not checked · 1 wrong lamp");
  });

  it("omits the instead-lit clause when the verdict is not a wrong lamp", () => {
    const markdown = evidenceMarkdown(
      vocabulary,
      groups,
      { "indicator:payment": { verdict: "correct", insteadOf: "semaphore:green", note: "" } },
      false,
      at,
    );
    expect(markdown).not.toContain("lit Semaphore / green instead");
  });

  it("stamps a mock run as not being evidence", () => {
    expect(evidenceMarkdown(vocabulary, groups, {}, true, at)).toContain("MOCK RUN — NOT EVIDENCE");
  });

  it("escapes a pipe in a note so one comment cannot break the table", () => {
    const markdown = evidenceMarkdown(
      vocabulary,
      groups,
      { "strip:blue": { verdict: "unlit", note: "tried on | off | on" } },
      false,
      at,
    );
    expect(markdown).toContain("tried on \\| off \\| on");
  });
});

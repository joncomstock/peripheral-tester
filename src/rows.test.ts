import { describe, expect, it } from "vitest";
import type { Vocabulary } from "./api.ts";
import { evidenceMarkdown, groupsFor, requestFor } from "./rows.ts";

/** Shaped like a real `/api/vocabulary` payload, trimmed to one row per group. */
const vocabulary: Vocabulary = {
  portName: "COM14",
  mock: false,
  actions: ["on", "off", "blink"],
  indicators: [{ section: "payment", channel: 1 }, { section: "passportReader", channel: 3 }],
  sides: [{ side: "left", channel: 8 }],
  stripColors: [{ color: "blue", channel: 2 }],
  semaphoreColors: [{ color: "yellow", channels: [6, 1] }],
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

  it("derives its rows from the payload rather than a copy of the vocabulary", () => {
    const extended = {
      ...vocabulary,
      indicators: [...vocabulary.indicators, { section: "gppDispenser" as const, channel: 5 }],
    };
    expect(groupsFor(extended)[0].rows.map((r) => r.label)).toEqual([
      "payment",
      "passportReader",
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

describe("evidenceMarkdown", () => {
  const groups = groupsFor(vocabulary);

  it("lists untested rows instead of dropping them", () => {
    const markdown = evidenceMarkdown(vocabulary, groups, {}, false, "2026-08-21T00:00:00.000Z");
    expect(markdown).toContain("Rows observed: 0 of 5");
    expect(markdown.match(/not tested/g)).toHaveLength(5);
  });

  it("records the verdict and note against the section and its channels", () => {
    const markdown = evidenceMarkdown(
      vocabulary,
      groups,
      { "indicator:payment": { verdict: "wrong-lamp", note: "semaphore green lit" } },
      false,
      "2026-08-21T00:00:00.000Z",
    );
    expect(markdown).toContain("| Indicators / payment (driver: unverified) | `AI;1` | lit something else | semaphore green lit |");
    expect(markdown).toContain("Rows observed: 1 of 5");
  });

  it("stamps a mock run as not being evidence", () => {
    expect(evidenceMarkdown(vocabulary, groups, {}, true, "2026-08-21T00:00:00.000Z"))
      .toContain("MOCK RUN — NOT EVIDENCE");
  });

  it("escapes a pipe in a note so one comment cannot break the table", () => {
    const markdown = evidenceMarkdown(
      vocabulary,
      groups,
      { "strip:blue": { verdict: "nothing-lit", note: "tried on | off | on" } },
      false,
      "2026-08-21T00:00:00.000Z",
    );
    expect(markdown).toContain("tried on \\| off \\| on");
  });
});

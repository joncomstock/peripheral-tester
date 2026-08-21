/**
 * Turns `/api/vocabulary` into the button grid, and the operator's observations into a record that
 * can be pasted into a PR.
 *
 * All of it derives from the payload. Nothing in here knows the name of a section or the number of a
 * channel, so this file cannot disagree with the driver about what the board has.
 */

import type {
  Action,
  IndicatorSection,
  LedRequest,
  SemaphoreColor,
  Side,
  StripColor,
  Vocabulary,
} from "./api.ts";

/** A `LedRequest` without its action — one per button row. */
export type LedBase =
  | { section: IndicatorSection }
  | { section: "bagTagPrinter"; side: Side }
  | { section: "semaphore"; color: SemaphoreColor }
  | { section: "strip"; color: StripColor };

export interface Row {
  /** Stable across reloads, so a recorded observation survives a refresh mid-run. */
  key: string;
  label: string;
  /** Channels as the wire addresses them, e.g. `AI;1` or `AI;6 AI;1`. */
  channels: string;
  /** Actions this row may send. The strip has no blink on the wire, so it does not offer one. */
  actions: Action[];
  base: LedBase;
  /** The driver reports this section's channel as never confirmed against hardware. */
  unverified: boolean;
}

export interface Group {
  title: string;
  rows: Row[];
}

/**
 * Builds the request for one button.
 *
 * Throws on `strip` + `blink` rather than quietly coercing it: the strip's channels take only
 * Active/Inactive, {@link groupsFor} therefore never offers the button, and a silent substitution
 * would send a command the operator did not ask for while the log claimed otherwise.
 */
export function requestFor(base: LedBase, action: Action): LedRequest {
  if (base.section === "strip") {
    if (action === "blink") throw new Error("the strip has no blink command on the wire");
    return { ...base, action };
  }
  return { ...base, action };
}

export function groupsFor(vocabulary: Vocabulary): Group[] {
  const { actions, unverified } = vocabulary;
  // Derived, not hard-coded: if the driver ever gains a blink for the strip, this stops filtering.
  const stripActions = actions.filter((action) => action !== "blink");

  return [
    {
      title: "Indicators",
      rows: vocabulary.indicators.map(({ section, channel }) => ({
        key: `indicator:${section}`,
        label: section,
        channels: `AI;${channel}`,
        actions,
        base: { section },
        unverified: unverified.includes(section),
      })),
    },
    {
      title: "Bag-tag printer",
      rows: vocabulary.sides.map(({ side, channel }) => ({
        key: `bagTag:${side}`,
        label: side,
        channels: `AI;${channel}`,
        actions,
        base: { section: "bagTagPrinter", side },
        unverified: unverified.includes("bagTagPrinter"),
      })),
    },
    {
      title: "Strip",
      rows: vocabulary.stripColors.map(({ color, channel }) => ({
        key: `strip:${color}`,
        label: color,
        channels: `AL;${channel}`,
        actions: stripActions,
        base: { section: "strip", color },
        unverified: unverified.includes("strip"),
      })),
    },
    {
      title: "Semaphore",
      rows: vocabulary.semaphoreColors.map(({ color, channels }) => ({
        key: `semaphore:${color}`,
        label: color,
        channels: channels.map((channel) => `AI;${channel}`).join(" "),
        actions,
        base: { section: "semaphore", color },
        unverified: unverified.includes("semaphore"),
      })),
    },
  ];
}

// ---- What the operator saw -----------------------------------------------------------------

export const VERDICTS = ["untested", "as-labelled", "wrong-lamp", "nothing-lit"] as const;
export type Verdict = typeof VERDICTS[number];

export const VERDICT_LABELS: Record<Verdict, string> = {
  "untested": "not tested",
  "as-labelled": "lit as labelled",
  "wrong-lamp": "lit something else",
  "nothing-lit": "nothing lit",
};

export interface Observation {
  verdict: Verdict;
  /** For `wrong-lamp`, which lamp lit — the actual finding, so it goes in the record. */
  note: string;
}

export type Observations = Record<string, Observation>;

/**
 * The record of a run, as markdown.
 *
 * Untested rows are listed rather than dropped: what was *not* confirmed is the part of the record
 * that stops a partial run being read as a complete one.
 */
export function evidenceMarkdown(
  vocabulary: Vocabulary,
  groups: Group[],
  observations: Observations,
  mock: boolean,
  now: string,
): string {
  const rows = groups.flatMap((group) => group.rows.map((row) => ({ group: group.title, row })));
  const seen = (key: string): Observation => observations[key] ?? { verdict: "untested", note: "" };
  const tested = rows.filter(({ row }) => seen(row.key).verdict !== "untested").length;

  const lines = [
    `# IER S33380 light board — observed on hardware`,
    "",
    ...(mock
      ? [
        "> **MOCK RUN — NOT EVIDENCE.** No board and no COM port were involved. Do not paste this",
        "> into a PR as an on-device result.",
        "",
      ]
      : []),
    `- Port: \`${vocabulary.portName}\``,
    `- Recorded: ${now}`,
    `- Rows observed: ${tested} of ${rows.length}`,
    "",
    "| Section | Channels | Observed | Notes |",
    "| --- | --- | --- | --- |",
    ...rows.map(({ group, row }) => {
      const { verdict, note } = seen(row.key);
      const label = `${group} / ${row.label}${row.unverified ? " (driver: unverified)" : ""}`;
      return `| ${label} | \`${row.channels}\` | ${VERDICT_LABELS[verdict]} | ${note.replaceAll("|", "\\|")} |`;
    }),
  ];
  return lines.join("\n") + "\n";
}

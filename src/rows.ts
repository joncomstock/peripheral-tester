/**
 * Turns `/api/vocabulary` into the wiring bay, and the operator's observations into a record that
 * can be pasted into a PR.
 *
 * All of it derives from the payload. Nothing in here knows the name of a section or the number of a
 * channel, so this file cannot disagree with the driver about what the board has.
 */

import type {
  Action,
  Claimant,
  Collision,
  IndicatorSection,
  LedRequest,
  SemaphoreColor,
  Side,
  StripColor,
  Vocabulary,
} from "./api.ts";

/** A `LedRequest` without its action — one per wire. */
export type LedBase =
  | { section: IndicatorSection }
  | { section: "bagTagPrinter"; side: Side }
  | { section: "semaphore"; color: SemaphoreColor }
  | { section: "strip"; color: StripColor };

export interface Row {
  /** Stable across reloads, so a recorded observation survives a refresh mid-run. */
  key: string;
  label: string;
  /** The group this row belongs to, so a record entry can name it without a second lookup. */
  group: string;
  /** Channels as the wire addresses them, e.g. `AI;1` or `AI;6 AI;1`. */
  channels: string;
  /** Actions this row may send. The strip has no blink on the wire, so it does not offer one. */
  actions: Action[];
  base: LedBase;
  /** The driver reports this section's channel as never confirmed against hardware. */
  unverified: boolean;
  /** Other rows reaching the same indicator pin. Named at the pin, where the clash physically is. */
  sharedWith: Claimant[];
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

/**
 * Everyone else on this row's pin.
 *
 * Matched on the claimant's id, which is the same scheme rows are keyed by, so the marker rendered
 * at the pin can navigate to the row it names. An earlier version matched the display label against
 * the row's group and label, and silently found nothing for every claimant whose label was not just
 * its section name — including `semaphore green`, the one collision the driver ships with.
 */
function claims(collisions: Collision[], key: string): Claimant[] {
  return collisions
    .filter((collision) => collision.claimants.some((claimant) => claimant.id === key))
    .flatMap((collision) => collision.claimants.filter((claimant) => claimant.id !== key));
}

export function groupsFor(vocabulary: Vocabulary): Group[] {
  const { actions, collisions, unverified } = vocabulary;
  // Derived, not hard-coded: if the driver ever gains a blink for the strip, this stops filtering.
  const stripActions = actions.filter((action) => action !== "blink");

  return [
    {
      title: "Indicators",
      rows: vocabulary.indicators.map(({ section, channel }) => ({
        key: `indicator:${section}`,
        label: section,
        group: "Indicators",
        channels: `AI;${channel}`,
        actions,
        base: { section },
        unverified: unverified.includes(section),
        sharedWith: claims(collisions, `indicator:${section}`),
      })),
    },
    {
      title: "Bag-tag printer",
      rows: vocabulary.sides.map(({ side, channel }) => ({
        key: `bagTag:${side}`,
        label: side,
        group: "Bag-tag printer",
        channels: `AI;${channel}`,
        actions,
        base: { section: "bagTagPrinter", side },
        unverified: unverified.includes("bagTagPrinter"),
        sharedWith: claims(collisions, `bagTag:${side}`),
      })),
    },
    {
      title: "Strip",
      rows: vocabulary.stripColors.map(({ color, channel }) => ({
        key: `strip:${color}`,
        label: color,
        group: "Strip",
        // AL, not AI: a different address space, which is why strip green 4 does not clash with
        // boardingPassPrinter 4 and why no strip row can ever be shared.
        channels: `AL;${channel}`,
        actions: stripActions,
        base: { section: "strip", color },
        unverified: unverified.includes("strip"),
        sharedWith: [],
      })),
    },
    {
      title: "Semaphore",
      rows: vocabulary.semaphoreColors.map(({ color, channels }) => ({
        key: `semaphore:${color}`,
        label: color,
        group: "Semaphore",
        channels: channels.map((channel) => `AI;${channel}`).join(" "),
        actions,
        base: { section: "semaphore", color },
        unverified: unverified.includes("semaphore"),
        sharedWith: claims(collisions, `semaphore:${color}`),
      })),
    },
  ];
}

// ---- What the operator saw -----------------------------------------------------------------

export const VERDICTS = ["untested", "correct", "astray", "unlit"] as const;
export type Verdict = typeof VERDICTS[number];

/** Named for what the eye saw, not for what the software would call it. */
export const VERDICT_LABELS: Record<Verdict, string> = {
  untested: "Not checked",
  correct: "Correct",
  astray: "Wrong lamp",
  unlit: "No light",
};

/** The three an operator can choose. `untested` is the absence of a choice, not a choice. */
export const CHOOSABLE: Exclude<Verdict, "untested">[] = ["correct", "astray", "unlit"];

export interface Observation {
  verdict: Verdict;
  /** For `astray`, the key of the row whose lamp actually lit — the run's best finding, as data. */
  insteadOf?: string;
  /** Anything the three verdicts and the pick cannot carry: "very dim", "flickered once". */
  note: string;
}

export type Observations = Record<string, Observation>;

export const UNOBSERVED: Observation = { verdict: "untested", note: "" };

/**
 * Observations as they come back out of storage.
 *
 * A trust boundary, and a version boundary: the verdict names changed once already, and a record
 * written by the older build put a verdict this build has no label for straight into the exported
 * markdown as `undefined`. An unrecognised verdict is therefore reset rather than trusted — but the
 * operator's typed note is kept, because it is the part no schema change can invalidate and the part
 * they cannot get back.
 */
export function parseObservations(stored: string): Observations {
  let raw: unknown;
  try {
    raw = JSON.parse(stored);
  }
  catch {
    return {};
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};

  const parsed: Observations = {};
  for (const [key, value] of Object.entries(raw as Record<string, Partial<Observation>>)) {
    if (!value || typeof value !== "object") continue;
    const known = VERDICTS.includes(value.verdict as Verdict);
    parsed[key] = {
      verdict: known ? value.verdict as Verdict : "untested",
      insteadOf: typeof value.insteadOf === "string" ? value.insteadOf : undefined,
      note: typeof value.note === "string" ? value.note : "",
    };
  }
  return parsed;
}

export interface Tally {
  verdict: Verdict;
  count: number;
}

export function tally(rows: Row[], observations: Observations): Tally[] {
  const counted = new Map<Verdict, number>(VERDICTS.map((verdict) => [verdict, 0]));
  for (const row of rows) {
    const { verdict } = observations[row.key] ?? UNOBSERVED;
    counted.set(verdict, (counted.get(verdict) ?? 0) + 1);
  }
  return VERDICTS.map((verdict) => ({ verdict, count: counted.get(verdict) ?? 0 }));
}

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
  const rows = groups.flatMap((group) => group.rows);
  const seen = (key: string): Observation => observations[key] ?? UNOBSERVED;
  const labels = new Map(rows.map((row) => [row.key, `${row.group} / ${row.label}`]));
  const labelOf = (key: string): string => labels.get(key) ?? key;
  const cell = (text: string) => text.replaceAll("|", "\\|");

  const counts = tally(rows, observations);
  const headline = counts
    .filter(({ count }) => count > 0)
    .map(({ verdict, count }) => `${count} ${VERDICT_LABELS[verdict].toLowerCase()}`)
    .join(" · ");

  return [
    "# IER S33380 light board — observed on hardware",
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
    `- ${headline}`,
    "",
    "| Section | Channels | Observed | Notes |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => {
      const { verdict, insteadOf, note } = seen(row.key);
      const name = `${row.group} / ${row.label}${row.unverified ? " (driver: unverified)" : ""}`;
      const notes = [
        insteadOf && verdict === "astray" ? `lit ${labelOf(insteadOf)} instead` : "",
        note,
      ].filter(Boolean).join("; ");
      return `| ${cell(name)} | \`${row.channels}\` | ${VERDICT_LABELS[verdict]} | ${cell(notes)} |`;
    }),
  ].join("\n") + "\n";
}

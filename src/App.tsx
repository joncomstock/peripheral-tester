import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Action, Door, LogEntry, Vocabulary } from "./api.ts";
import { getStatus, getVocabulary, sendAllOff, sendLed, subscribe } from "./api.ts";
import type { Group, Observation, Observations, Row } from "./rows.ts";
import {
  CHOOSABLE,
  evidenceMarkdown,
  groupsFor,
  parseObservations,
  requestFor,
  tally,
  UNOBSERVED,
  VERDICT_LABELS,
} from "./rows.ts";

const MAX_LINES = 500;

/**
 * Storage schema. Bumped when the shape of an {@link Observation} changes.
 *
 * v1 held the older verdict names and put `undefined` into the exported record when this build read
 * it back. `parseObservations` now guards that, but the version is what makes the next change
 * explicit rather than silent. v1 records are not migrated: it was never run outside development.
 */
const SCHEMA = "v2";
const storageKey = (portName: string) => `ier-lightboard-tester:${SCHEMA}:${portName}`;

/**
 * Storage that cannot take the page down with it.
 *
 * `getItem` and `setItem` throw in private browsing and when the quota is gone. An unguarded read
 * threw into the boot chain and surfaced as "no backend on this port", blaming the wrong thing
 * entirely; an unguarded write threw out of an effect.
 */
function readObservations(portName: string): Observations {
  try {
    const stored = localStorage.getItem(storageKey(portName));
    return stored ? parseObservations(stored) : {};
  }
  catch {
    return {};
  }
}

function writeObservations(portName: string, observations: Observations): boolean {
  try {
    localStorage.setItem(storageKey(portName), JSON.stringify(observations));
    return true;
  }
  catch {
    return false;
  }
}

/** Kinds carrying something the board said that the driver could not account for. */
const UNEXPECTED = ["warned", "data"];

/** A shape warning names the token in quotes: `'AI;3=O' answered with 'AI;3=O@', expected 'AI@'`. */
const ANSWERED_WITH = /answered with '([^']+)'/;

/* Static, so it is not rebuilt on every render. States the row grammar once for the whole bay. */
const GRAMMAR = (
  <div className="grammar" aria-hidden="true">
    <span className="grammar__step">Section</span>
    <span className="grammar__step">You send</span>
    <span className="grammar__step">It reaches</span>
    <span className="grammar__step">Your eyes saw</span>
  </div>
);

export function App() {
  const [vocabulary, setVocabulary] = useState<Vocabulary | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [doors, setDoors] = useState<Record<Door, string>>({ upper: "unknown", lower: "unknown" });
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [observations, setObservations] = useState<Observations>({});
  const [kindFilter, setKindFilter] = useState("everything");
  /** Row key → send count, so the pulse can replay on every command rather than only the first. */
  const [fired, setFired] = useState<Record<string, number>>({});
  const [called, setCalled] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const append = (entry: LogEntry) => setEntries((previous) => [...previous, entry].slice(-MAX_LINES));

  useEffect(() => {
    let live = true;
    (async () => {
      const [loaded, status] = await Promise.all([getVocabulary(), getStatus()]);
      if (!live) return;
      setVocabulary(loaded);
      setDoors(status.doors);
      setEntries(status.log.slice(-MAX_LINES));
      // Read before the persisting effect can run, so a refresh mid-run does not wipe the record.
      setObservations(readObservations(loaded.portName));
    })().catch((err: Error) => {
      if (live) setUnreachable(err.message);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!vocabulary) return;
    return subscribe(
      (entry) => {
        append(entry);
        // The backend tracks door state authoritatively; re-reading it beats parsing a log line.
        if (entry.kind === "door") getStatus().then((status) => setDoors(status.doors)).catch(() => {});
      },
      (message) => append({ at: "", kind: "error", text: message }),
    );
  }, [vocabulary]);

  useEffect(() => {
    if (!vocabulary) return;
    // The record is the deliverable of the run, so a storage failure is said out loud rather than
    // swallowed — the operator can still copy it before the tab closes.
    if (!writeObservations(vocabulary.portName, observations)) {
      append({ at: "", kind: "failed", text: "the browser refused to save the record — copy it before closing this tab" });
    }
  }, [vocabulary, observations]);

  const groups = useMemo(() => (vocabulary ? groupsFor(vocabulary) : []), [vocabulary]);
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const markdown = useMemo(
    () =>
      vocabulary
        ? evidenceMarkdown(vocabulary, groups, observations, vocabulary.mock, new Date().toISOString())
        : "",
    [vocabulary, groups, observations],
  );
  const counts = useMemo(() => tally(rows, observations), [rows, observations]);
  // Keyed on the log alone: typing a note used to rescan every entry with a regex on each keystroke.
  const unexpected = useMemo(() => distinctUnexpected(entries), [entries]);
  const recorded = rows.length - (counts.find((entry) => entry.verdict === "untested")?.count ?? 0);

  const failed = (err: Error) => append({ at: "", kind: "failed", text: err.message });

  const send = (row: Row, action: Action) => {
    setFired((previous) => ({ ...previous, [row.key]: (previous[row.key] ?? 0) + 1 }));
    sendLed(requestFor(row.base, action)).catch(failed);
  };

  /*
   * A CSS animation with no fill mode snaps back to its start when it ends, which left a copper stub
   * parked at the head of every row that had ever been fired. The pulse is a moment, so it is
   * unmounted once it has been one.
   */
  const spent = (key: string) =>
    setFired((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });

  const observe = (key: string, change: Partial<Observation>) =>
    setObservations((previous) => ({ ...previous, [key]: { ...(previous[key] ?? UNOBSERVED), ...change } }));

  /** Jump to the other section sharing a pin — the clash is only useful if you can see both ends. */
  const callOut = useCallback((key: string) => {
    const target = rowRefs.current.get(key);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    setCalled(key);
  }, []);

  if (unreachable) {
    return (
      <main className="gate">
        <h1 className="gate__title">No backend on this port</h1>
        <p className="gate__detail">{unreachable}</p>
        <p className="gate__fix">
          The backend holds the COM handle, and only the process holding it can drive the board. Start it
          with <code>deno task dev</code> for a wired board, or <code>deno task dev:mock</code> for none.
        </p>
      </main>
    );
  }

  if (!vocabulary) {
    return (
      <main className="gate">
        <p className="gate__fix">Opening the port…</p>
      </main>
    );
  }

  const kinds = ["everything", ...new Set(entries.map((entry) => entry.kind))];
  const shown = kindFilter === "everything" ? entries : entries.filter((entry) => entry.kind === kindFilter);

  return (
    <div className="rig">
      <header className="masthead">
        <h1 className="masthead__mark">IER S33380</h1>
        <span className="masthead__sub">light board</span>
        <div className="masthead__readout">
          <div className="dial">
            <span className="dial__key">Port</span>
            <span className={`dial__value${vocabulary.mock ? " dial__value--mock" : ""}`}>
              {vocabulary.mock ? "mock — no board" : vocabulary.portName}
            </span>
          </div>
          <div className="dial">
            <span className="dial__key">Recorded</span>
            <span className="dial__value">{recorded} / {rows.length}</span>
          </div>
        </div>
      </header>

      <div className="thesis">
        <p className="thesis__claim">
          The board answers.<br />
          <em>It does not confirm.</em>
        </p>
        <p className="thesis__body">
          A command reads <strong>answered</strong> the moment the board replies, which proves the wire and
          not the lamp. Only your eyes can say which lamp lit — say it at the end of each row. Two channels
          below were never confirmed against hardware, and one of them shares a pin.
        </p>
      </div>

      {vocabulary.mock && (
        <div className="alarm">
          <span className="alarm__tag">Mock</span>
          <p className="alarm__text">
            A fake transport, driven through the real driver. No COM port and no board — nothing recorded
            here is evidence about hardware.
          </p>
        </div>
      )}

      <div className="benches">
        <section>
          <div className="bench__head">
            <h2 className="bench__title">Outbound</h2>
            <span className="bench__note">what you send</span>
          </div>

          <button className="darken" onClick={() => sendAllOff().catch(failed)}>
            Darken every lamp
          </button>

          {GRAMMAR}

          {groups.map((group) => (
            <Bay
              key={group.title}
              group={group}
              observations={observations}
              fired={fired}
              called={called}
              rows={rows}
              rowRefs={rowRefs}
              onSend={send}
              onObserve={observe}
              onCallOut={callOut}
              onSpent={spent}
            />
          ))}
        </section>

        <aside className="inbound">
          <div className="bench__head" style={{ padding: "16px 16px 0", marginBottom: 0 }}>
            <h2 className="bench__title">Inbound</h2>
            <span className="bench__note">what the board sends back</span>
          </div>

          <div className="inbound__block">
            <h3 className="inbound__title">Service doors</h3>
            <div className="doors">
              {(["upper", "lower"] as Door[]).map((door) => (
                <span className={`door${doors[door] === "open" ? " door--open" : ""}`} key={door}>
                  <span className={`door__slot door__slot--${doors[door] === "unknown" ? "unknown" : doors[door]}`} />
                  {door} <span className="door__state">{doors[door]}</span>
                </span>
              ))}
            </div>
          </div>

          <div className="inbound__block">
            <h3 className="inbound__title">Replies the driver did not expect</h3>
            {unexpected.length === 0
              ? <p className="quiet">Nothing unexpected yet.</p>
              : (
                <div className="tokens">
                  {unexpected.map(({ text, count }) => (
                    <span className="token" key={text}>
                      {text} <span className="token__count">×{count}</span>
                    </span>
                  ))}
                </div>
              )}
          </div>

          <div className="inbound__block">
            <h3 className="inbound__title">Stream</h3>
            <label>
              <span className="dial__key">Show </span>
              <select className="filter" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
                {kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </label>
            {/* Newest first, so the latest reply is on screen without scroll-following logic. */}
            <div className="stream" role="log">
              {shown.slice().reverse().map((entry, index) => (
                <div className={`stream__line stream__line--${entry.kind}`} key={index}>
                  <span className="stream__head">
                    <span className="stream__at">{entry.at}</span>
                    <span className="stream__kind">{entry.kind}</span>
                  </span>
                  <span className="stream__text">{phrase(entry)}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      <section className="record">
        <div className="bench__head">
          <h2 className="bench__title">The record</h2>
          <span className="bench__note">kept per port, across reloads</span>
        </div>

        <div className="record__tally">
          {counts.map(({ verdict, count }) => (
            <span className={`tally tally--${verdict}${count === 0 ? " tally--zero" : ""}`} key={verdict}>
              <span className="tally__n">{count}</span>
              <span className="tally__label">{VERDICT_LABELS[verdict]}</span>
            </span>
          ))}
        </div>

        <Sheet markdown={markdown} />
      </section>
    </div>
  );
}

/**
 * A command, in the words the row uses.
 *
 * The backend records a send as the request's JSON, which wraps badly and reads like a wire dump.
 * Only outbound commands are rephrased — a reply is quoted exactly as it arrived, because a reply
 * nobody expected is the finding this whole page is here to catch.
 */
function phrase(entry: LogEntry): string {
  if (entry.kind !== "sent") return entry.text;
  try {
    const request = JSON.parse(entry.text) as Record<string, string>;
    const { section, action, ...rest } = request;
    const qualifier = Object.values(rest).join(" ");
    return [section, qualifier, "·", action].filter(Boolean).join(" ");
  }
  catch {
    // `allOff` and anything else that is not a request. It is already a phrase.
    return entry.text;
  }
}

/** Distinct texts the board sent that the driver could not account for, commonest first. */
function distinctUnexpected(entries: LogEntry[]): { text: string; count: number }[] {
  const counted = new Map<string, number>();
  for (const entry of entries) {
    if (!UNEXPECTED.includes(entry.kind)) continue;
    // The token is what the operator needs; the sentence around it is the same every time.
    const quoted = entry.text.match(ANSWERED_WITH);
    const text = quoted ? quoted[1] : entry.text;
    counted.set(text, (counted.get(text) ?? 0) + 1);
  }
  return [...counted]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count);
}

function Bay(
  { group, observations, fired, called, rows, rowRefs, onSend, onObserve, onCallOut, onSpent }: {
    group: Group;
    observations: Observations;
    fired: Record<string, number>;
    called: string | null;
    rows: Row[];
    rowRefs: React.MutableRefObject<Map<string, HTMLDivElement>>;
    onSend: (row: Row, action: Action) => void;
    onObserve: (key: string, change: Partial<Observation>) => void;
    onCallOut: (key: string) => void;
    onSpent: (key: string) => void;
  },
) {
  return (
    <div className="group">
      <h3 className="group__title">{group.title}</h3>
      {group.rows.map((row) => (
        <Wire
          key={row.key}
          row={row}
          observation={observations[row.key] ?? UNOBSERVED}
          firing={fired[row.key] ?? 0}
          called={called === row.key}
          rows={rows}
          register={(element) => {
            if (element) rowRefs.current.set(row.key, element);
            else rowRefs.current.delete(row.key);
          }}
          onSend={(action) => onSend(row, action)}
          onObserve={(change) => onObserve(row.key, change)}
          onCallOut={onCallOut}
          onSpent={() => onSpent(row.key)}
        />
      ))}
    </div>
  );
}

/**
 * One wire: name → what you send → the pin it reaches → what your eyes saw.
 *
 * The signal path stops at the pin, and so does the pulse. Nothing past the pin is established by
 * software, which is why the last cell belongs to the operator.
 */
function Wire(
  { row, observation, firing, called, rows, register, onSend, onObserve, onCallOut, onSpent }: {
    row: Row;
    observation: Observation;
    firing: number;
    called: boolean;
    rows: Row[];
    register: (element: HTMLDivElement | null) => void;
    onSend: (action: Action) => void;
    onObserve: (change: Partial<Observation>) => void;
    onCallOut: (key: string) => void;
    onSpent: () => void;
  },
) {
  const classes = [
    "wire",
    row.unverified || row.sharedWith.length > 0 ? "wire--flagged" : "",
    called ? "wire--called" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={classes} ref={register}>
      {firing > 0 && <span className="wire__pulse" key={firing} onAnimationEnd={onSpent} />}

      <div className="wire__cell wire__id">
        <span className="wire__name">{row.label}</span>
        {row.unverified && <span className="wire__caveat">unverified</span>}
      </div>

      <div className="wire__cell wire__send">
        {row.actions.map((action) => (
          <button
            className="send"
            key={action}
            onClick={() => onSend(action)}
            aria-label={`send ${action} to ${row.label}`}
          >
            {action}
          </button>
        ))}
      </div>

      <div className="wire__cell">
        <span className="pin">{row.channels}</span>
        {row.sharedWith.map((claimant) => (
          <button className="pin__shared" key={claimant.id} onClick={() => onCallOut(claimant.id)}>
            + {claimant.label}
          </button>
        ))}
      </div>

      <div className="wire__cell saw" role="group" aria-label={`what ${row.label} did`}>
        {CHOOSABLE.map((verdict) => (
          <button
            className={`saw__opt saw__opt--${verdict === "unlit" ? "dark" : verdict}`}
            key={verdict}
            aria-pressed={observation.verdict === verdict}
            title="click again to clear"
            onClick={() =>
              onObserve({ verdict: observation.verdict === verdict ? "untested" : verdict })}
          >
            {VERDICT_LABELS[verdict]}
          </button>
        ))}
      </div>

      {observation.verdict !== "untested" && (
        <div className="instead">
          {observation.verdict === "astray" && (
            <>
              <span className="instead__label instead__label--astray">Which lit?</span>
              <select
                className="instead__pick"
                value={observation.insteadOf ?? ""}
                onChange={(event) => onObserve({ insteadOf: event.target.value })}
                aria-label={`which lamp lit instead of ${row.label}`}
              >
                <option value="">choose a lamp</option>
                {rows.filter((other) => other.key !== row.key).map((other) => (
                  <option key={other.key} value={other.key}>{other.group} / {other.label}</option>
                ))}
              </select>
            </>
          )}
          <span className="instead__label">Note</span>
          <input
            className="instead__note"
            placeholder="only if there is more to say"
            value={observation.note}
            onChange={(event) => onObserve({ note: event.target.value })}
            aria-label={`note for ${row.label}`}
          />
        </div>
      )}
    </div>
  );
}

function Sheet({ markdown }: { markdown: string }) {
  const [said, setSaid] = useState("");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setSaid("Record copied");
    }
    catch {
      // Clipboard access is refused outside a secure context. Say so rather than appearing to work.
      setSaid("The browser refused the clipboard — select the text and copy it");
    }
  };

  return (
    <>
      <textarea className="record__sheet" readOnly value={markdown} aria-label="run record as markdown" />
      <div className="record__actions">
        <button className="copy" onClick={copy}>Copy record</button>
        <span className="said" role="status">{said}</span>
      </div>
    </>
  );
}

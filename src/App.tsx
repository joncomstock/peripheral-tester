import { useEffect, useMemo, useState } from "react";
import type { Action, Door, LogEntry, Vocabulary } from "./api.ts";
import { getStatus, getVocabulary, sendAllOff, sendLed, subscribe } from "./api.ts";
import type { LedBase, Observation, Observations, Row, Verdict } from "./rows.ts";
import { evidenceMarkdown, groupsFor, requestFor, VERDICT_LABELS, VERDICTS } from "./rows.ts";

const MAX_LINES = 500;
const UNTESTED: Observation = { verdict: "untested", note: "" };
const storageKey = (portName: string) => `ier-lightboard-tester:observations:${portName}`;

export function App() {
  const [vocabulary, setVocabulary] = useState<Vocabulary | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [doors, setDoors] = useState<Record<Door, string>>({ upper: "unknown", lower: "unknown" });
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [observations, setObservations] = useState<Observations>({});
  const [kindFilter, setKindFilter] = useState("all");

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
      const stored = localStorage.getItem(storageKey(loaded.portName));
      if (stored) setObservations(JSON.parse(stored) as Observations);
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
    localStorage.setItem(storageKey(vocabulary.portName), JSON.stringify(observations));
  }, [vocabulary, observations]);

  const groups = useMemo(() => (vocabulary ? groupsFor(vocabulary) : []), [vocabulary]);
  const markdown = useMemo(
    () => (vocabulary ? evidenceMarkdown(vocabulary, groups, observations, vocabulary.mock, new Date().toISOString()) : ""),
    [vocabulary, groups, observations],
  );

  const failed = (err: Error) => append({ at: "", kind: "failed", text: err.message });
  const send = (base: LedBase, action: Action) => sendLed(requestFor(base, action)).catch(failed);
  const observe = (key: string, change: Partial<{ verdict: Verdict; note: string }>) =>
    setObservations((previous) => {
      const current = previous[key] ?? UNTESTED;
      return { ...previous, [key]: { ...current, ...change } };
    });

  if (unreachable) {
    return (
      <main className="page">
        <h1>IER S33380 light board tester</h1>
        <p className="alert">
          The backend is not answering: <code>{unreachable}</code>
        </p>
        <p className="hint">
          It owns the COM port — the browser cannot reach the board without it. Start it with{" "}
          <code>deno task dev</code> for a wired board, or <code>deno task dev:mock</code> for none.
        </p>
      </main>
    );
  }

  if (!vocabulary) return <main className="page"><p className="hint">connecting…</p></main>;

  const kinds = ["all", ...new Set(entries.map((entry) => entry.kind))];
  const shown = kindFilter === "all" ? entries : entries.filter((entry) => entry.kind === kindFilter);

  return (
    <main className="page">
      <header>
        <h1>IER S33380 light board tester</h1>
        <span className="port">{vocabulary.portName}</span>
        {vocabulary.mock && <span className="badge-mock">MOCK — NO BOARD</span>}
      </header>

      <p className="note">
        <strong>Watch the board, not the screen.</strong> A command that reports <em>sent</em> only means the
        board answered — not that the lamp you expected lit. Two channel defaults were never confirmed on
        hardware. Anything the board replies with that is not the expected token appears in the log verbatim:
        that is the value of this run.
      </p>

      {vocabulary.mock && (
        <p className="alert">
          A fake transport is driving the real driver. Nothing here is evidence about a board.
        </p>
      )}

      {vocabulary.collisions.length > 0 && (
        <section>
          <h2>Channel collisions</h2>
          <div className="hint">
            Computed from the live channel map. Both sections drive the same indicator channel, so one will
            light the other's lamp.
          </div>
          {vocabulary.collisions.map((collision) => (
            <div className="row" key={collision.channel}>
              <span className="label">AI;{collision.channel}</span>
              <span className="flag">{collision.labels.join("  ·  ")}</span>
            </div>
          ))}
        </section>
      )}

      <div className="layout">
        <div>
          <section>
            <h2>Doors</h2>
            <div className="doors">
              {(["upper", "lower"] as Door[]).map((door) => (
                <div className="door" key={door}>
                  <span className={`dot ${doors[door] === "open" || doors[door] === "closed" ? doors[door] : ""}`} />
                  {door} {doors[door]}
                </div>
              ))}
            </div>
            <div className="hint">Open and close each service door and confirm both transitions arrive.</div>
          </section>

          <section>
            <h2>All off</h2>
            <button className="wide off" onClick={() => sendAllOff().catch(failed)}>Darken every lamp</button>
            <div className="hint">One command per indicator, bag-tag side and strip colour, repeats removed.</div>
          </section>

          {groups.map((group) => (
            <section key={group.title}>
              <h2>{group.title}</h2>
              {group.rows.map((row) => (
                <RowControls
                  key={row.key}
                  row={row}
                  observation={observations[row.key] ?? UNTESTED}
                  onSend={(action) => send(row.base, action)}
                  onObserve={(change) => observe(row.key, change)}
                />
              ))}
            </section>
          ))}
        </div>

        <div>
          <section>
            <h2>Log</h2>
            <label className="filter">
              show{" "}
              <select value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
                {kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
              </select>
            </label>
            {/* Newest first, so the latest reply is on screen without scroll-following logic. */}
            <div className="log" role="log">
              {shown.slice().reverse().map((entry, index) => (
                <div className={`line k-${entry.kind}`} key={index}>
                  <span className="at">{entry.at}</span> <span className="kind">{entry.kind}</span> {entry.text}
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2>What the board did</h2>
            <div className="hint">
              Kept per port and across reloads. Paste this into the PR — it is the deliverable of an on-device
              run, and the rows left as <em>not tested</em> are part of it.
            </div>
            <Evidence markdown={markdown} />
          </section>
        </div>
      </div>
    </main>
  );
}

function RowControls(
  { row, observation, onSend, onObserve }: {
    row: Row;
    observation: Observation;
    onSend: (action: Action) => void;
    onObserve: (change: Partial<{ verdict: Verdict; note: string }>) => void;
  },
) {
  return (
    <div className="row">
      <span className="label">
        {row.label} <span className="ch">{row.channels}</span>
      </span>
      <span className="actions">
        {row.actions.map((action) => (
          <button key={action} className={action === "off" ? "off" : ""} onClick={() => onSend(action)}>
            {action}
          </button>
        ))}
      </span>
      {row.unverified && <span className="flag">UNVERIFIED</span>}
      <select
        aria-label={`what ${row.label} did`}
        className={`verdict v-${observation.verdict}`}
        value={observation.verdict}
        onChange={(event) => onObserve({ verdict: event.target.value as Verdict })}
      >
        {VERDICTS.map((verdict) => <option key={verdict} value={verdict}>{VERDICT_LABELS[verdict]}</option>)}
      </select>
      {observation.verdict !== "untested" && (
        <input
          aria-label={`note for ${row.label}`}
          className="note-input"
          placeholder={observation.verdict === "wrong-lamp" ? "which lamp lit?" : "notes"}
          value={observation.note}
          onChange={(event) => onObserve({ note: event.target.value })}
        />
      )}
    </div>
  );
}

function Evidence({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState("");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied("copied");
    }
    catch {
      // Clipboard access is refused outside a secure context. Say so rather than appearing to work.
      setCopied("clipboard refused — select the text and copy it");
    }
  };

  return (
    <>
      <textarea className="evidence" readOnly value={markdown} aria-label="run record as markdown" />
      <button onClick={copy}>Copy markdown</button> <span className="hint">{copied}</span>
    </>
  );
}

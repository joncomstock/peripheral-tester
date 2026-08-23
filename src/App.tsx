import { useCallback, useEffect, useRef, useState } from "react";
import type { CardReaderState, LogEntry, PassportReaderState, Snapshot } from "./api.ts";
import * as api from "./api.ts";
import { Activity } from "./Activity.tsx";
import { Home } from "./Home.tsx";
import type { View } from "./Home.tsx";
import { CardReaderControls, CardReaderPage } from "./CardReaderPage.tsx";
import { PassportReaderControls, PassportReaderPage } from "./PassportReaderPage.tsx";
import { LightBoardControls, LightBoardPage, phrase as lightboardPhrase } from "./LightBoardPage.tsx";

const MAX_LINES = 200;

const TITLES: Record<View, { title: string; sub: string }> = {
  home: { title: "Peripheral Tester", sub: "IER 919 · kiosk peripherals" },
  lightboard: { title: "Light Board", sub: "IER S33380" },
  cardreader: { title: "Card Reader", sub: "Hitachi-Omron V4KU" },
  passportreader: { title: "Passport Reader", sub: "DESKO PENTA Scanner" },
};

/**
 * The shell: which device is on screen, and the state every screen shares.
 *
 * One connection to the backend and one event stream serve every device. A device page renders the
 * controls for its peripheral and nothing else; the connection chrome for whichever device is open
 * sits in the masthead beside the title.
 */
export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [view, setView] = useState<View>("home");
  /** Set once the stream has supplied a snapshot, after which the initial fetch is stale. */
  const hydrated = useRef(false);

  /**
   * The stream is opened first and reconciled from, not merely appended to.
   *
   * `EventSource` reconnects by itself, and every connection — first or reconnect — begins with a
   * `hello` carrying a whole snapshot. Treating that as authoritative closes two gaps at once:
   * anything that happened before the stream was listening, and anything that happened while it was
   * silently away. Nothing has to reason about what was missed.
   */
  useEffect(() => {
    return api.subscribe(
      (event) => {
        if (event.type === "hello") {
          hydrated.current = true;
          const { type: _type, ...snapshot } = event;
          setSnapshot(snapshot);
          setLog(snapshot.log.slice(-MAX_LINES));
          setUnreachable(null);
          return;
        }
        if (event.type === "log") {
          setLog((previous) => [...previous, event.entry].slice(-MAX_LINES));
          return;
        }
        // A device's own state replaces its slice. The vocabulary only ever arrives in a snapshot,
        // so it is carried forward rather than clobbered.
        setSnapshot((previous) => {
          if (!previous) return previous;
          if (event.device === "lightboard") {
            return { ...previous, lightboard: { ...previous.lightboard, ...event.state } };
          }
          if (event.device === "passportreader") {
            return { ...previous, passportreader: event.state as PassportReaderState };
          }
          return { ...previous, cardreader: event.state as CardReaderState };
        });
      },
      (message) => setLog((previous) => [...previous, systemLine(message)].slice(-MAX_LINES)),
    );
  }, []);

  /**
   * A first read, only so a backend that is not there says so immediately.
   *
   * The stream's `hello` supplies the same snapshot, so this defers to it: a reply that arrives
   * after the stream has already hydrated is older than what is on screen and is dropped.
   */
  useEffect(() => {
    let live = true;
    api.getSnapshot()
      .then((loaded) => {
        if (!live || hydrated.current) return;
        setSnapshot(loaded);
        setLog(loaded.log.slice(-MAX_LINES));
      })
      .catch((err: Error) => {
        if (live && !hydrated.current) setUnreachable(err.message);
      });
    return () => {
      live = false;
    };
  }, []);

  const fail = useCallback((message: string) => {
    setLog((previous) => [...previous, systemLine(message)].slice(-MAX_LINES));
  }, []);

  if (unreachable) {
    return (
      <div className="gate">
        <h1>Backend not answering</h1>
        <p className="gate-detail">{unreachable}</p>
        <p>
          It holds every device handle, and the browser cannot reach hardware without it. Start it with{" "}
          <code>deno task dev</code>, or <code>deno task dev:mock</code> for no hardware.
        </p>
      </div>
    );
  }

  if (!snapshot) return <div className="gate"><p>Loading…</p></div>;

  const { title, sub } = TITLES[view];

  // Rendered by whichever page is open, at the foot of its side column.
  const activity = (
    <Activity
      log={log}
      only={view === "home" ? undefined : view}
      phrase={view === "lightboard" ? lightboardPhrase : undefined}
      onClear={() => setLog([])}
    />
  );

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          {view === "home"
            ? <span className="mark" />
            : (
              <button className="back" onClick={() => setView("home")} aria-label="back to devices">
                ←
              </button>
            )}
          <span className="brand-text">
            <span className="brand-name">{title}</span>
            <span className="brand-model">{sub}</span>
          </span>
        </div>

        {view === "lightboard" && <LightBoardControls state={snapshot.lightboard} onFail={fail} />}
        {view === "cardreader" && <CardReaderControls state={snapshot.cardreader} onFail={fail} />}
        {view === "passportreader" && <PassportReaderControls state={snapshot.passportreader} onFail={fail} />}
      </header>

      <main className="main">
        {view === "home" && <Home snapshot={snapshot} onOpen={setView} aside={activity} />}
        {view === "lightboard" && <LightBoardPage state={snapshot.lightboard} onFail={fail} aside={activity} />}
        {view === "cardreader" && <CardReaderPage state={snapshot.cardreader} onFail={fail} aside={activity} />}
        {view === "passportreader" && <PassportReaderPage state={snapshot.passportreader} onFail={fail} aside={activity} />}
      </main>
    </div>
  );
}

const systemLine = (text: string): LogEntry => ({ at: "", device: "system", kind: "failed", text });

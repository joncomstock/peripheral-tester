import { useCallback, useEffect, useState } from "react";
import type { CardReaderState, LogEntry, Snapshot } from "./api.ts";
import * as api from "./api.ts";
import { Activity } from "./Activity.tsx";
import { Home } from "./Home.tsx";
import type { View } from "./Home.tsx";
import { CardReaderControls, CardReaderPage } from "./CardReaderPage.tsx";
import { LightBoardControls, LightBoardPage, phrase as lightboardPhrase } from "./LightBoardPage.tsx";

const MAX_LINES = 200;

const TITLES: Record<View, { title: string; sub: string }> = {
  home: { title: "Peripheral Tester", sub: "IER 919 · kiosk peripherals" },
  lightboard: { title: "Light Board", sub: "IER S33380" },
  cardreader: { title: "Card Reader", sub: "Hitachi-Omron V4KU" },
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

  useEffect(() => {
    let live = true;
    api.getSnapshot()
      .then((loaded) => {
        if (!live) return;
        setSnapshot(loaded);
        setLog(loaded.log.slice(-MAX_LINES));
      })
      .catch((err: Error) => {
        if (live) setUnreachable(err.message);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    return api.subscribe(
      (event) => {
        if (event.type === "log") {
          setLog((previous) => [...previous, event.entry].slice(-MAX_LINES));
          return;
        }
        if (event.type !== "state") return;
        // A device's own state replaces its slice; the vocabulary is only ever sent in a snapshot,
        // so it is carried forward rather than clobbered.
        setSnapshot((previous) => {
          if (!previous) return previous;
          if (event.device === "lightboard") {
            return { ...previous, lightboard: { ...previous.lightboard, ...event.state } };
          }
          return { ...previous, cardreader: event.state as CardReaderState };
        });
      },
      (message) => setLog((previous) => [...previous, systemLine(message)].slice(-MAX_LINES)),
    );
  }, [snapshot !== null]);

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
      </header>

      <main className="main">
        {view === "home" && <Home snapshot={snapshot} onOpen={setView} aside={activity} />}
        {view === "lightboard" && <LightBoardPage state={snapshot.lightboard} onFail={fail} aside={activity} />}
        {view === "cardreader" && <CardReaderPage state={snapshot.cardreader} onFail={fail} aside={activity} />}
      </main>
    </div>
  );
}

const systemLine = (text: string): LogEntry => ({ at: "", device: "system", kind: "failed", text });

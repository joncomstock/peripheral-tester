import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import type { BaseState, LogEntry, Snapshot } from "./api.ts";
import * as api from "./api.ts";
import { stateOf } from "./api.ts";
import { Activity } from "./Activity.tsx";
import { DEVICES, Home, KIOSKS } from "./Home.tsx";
import type { DeviceId, Kiosk, View } from "./Home.tsx";
import { CardReaderPage } from "./CardReaderPage.tsx";
import { LightBoardControls, LightBoardPage, phrase as lightboardPhrase } from "./LightBoardPage.tsx";
import { SankyoPage } from "./SankyoPage.tsx";
import { PentaPage } from "./PentaPage.tsx";
import { Settings } from "./Settings.tsx";
import { DeviceControls } from "./ui.tsx";

const MAX_LINES = 200;

/** A device's screen. Each takes its own state shape, so they are registered through this one type. */
type DevicePage = ComponentType<{ state: BaseState; onFail: (message: string) => void; aside: ReactNode }>;

/** The screen for each device. A device's header controls are the shared ones, except the light board's. */
const PAGES: Partial<Record<DeviceId, DevicePage>> = {
  lightboard: LightBoardPage as unknown as DevicePage,
  cardreader: CardReaderPage as unknown as DevicePage,
  sankyo: SankyoPage as unknown as DevicePage,
  penta: PentaPage as unknown as DevicePage,
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
  const [kiosk, setKiosk] = useState<Kiosk>(storedKiosk);
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
        if (event.type === "mode") {
          setSnapshot((previous) => previous && { ...previous, mock: event.mock });
          return;
        }
        // A device's own state replaces its slice. The light board's vocabulary only ever arrives in
        // a snapshot, so it is carried forward rather than clobbered.
        setSnapshot((previous) => {
          if (!previous) return previous;
          if (event.device === "lightboard") {
            return { ...previous, lightboard: { ...previous.lightboard, ...event.state } };
          }
          return { ...previous, [event.device]: event.state };
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

  const title = view === "home" ? "Peripheral Tester" : DEVICES[view].name;
  const sub = view === "home" ? `${KIOSKS[kiosk].name} · kiosk peripherals` : DEVICES[view].model;
  const deviceState = view === "home" ? undefined : stateOf(snapshot, view);
  const Page = view === "home" ? undefined : PAGES[view];
  const chooseKiosk = (next: Kiosk) => {
    setKiosk(next);
    // Remembered per browser, so the kiosk's own screen keeps its model. Storage may be unavailable.
    try {
      localStorage.setItem(KIOSK_KEY, next);
    }
    catch { /* the choice still holds for this session */ }
  };

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
          {/* Always on screen while simulating, so a demo is never mistaken for real hardware. */}
          {snapshot.mock && <span className="mock-badge">Mock</span>}
        </div>

        {view === "lightboard" && <LightBoardControls state={snapshot.lightboard} onFail={fail} />}
        {view !== "home" && view !== "lightboard" && deviceState && (
          <DeviceControls
            state={deviceState}
            bus={DEVICES[view].bus}
            onConnect={() => api.device(view).connect()}
            onDisconnect={() => api.device(view).disconnect()}
            onFail={fail}
          />
        )}
        <Settings snapshot={snapshot} onFail={fail} />
      </header>

      <main className="main">
        {view === "home" && (
          <Home
            snapshot={snapshot}
            kiosk={kiosk}
            onKiosk={chooseKiosk}
            onOpen={setView}
            aside={activity}
          />
        )}
        {Page && deviceState && <Page state={deviceState} onFail={fail} aside={activity} />}
      </main>
    </div>
  );
}

const KIOSK_KEY = "peripheral-tester.kiosk";

function storedKiosk(): Kiosk {
  try {
    const saved = localStorage.getItem(KIOSK_KEY);
    if (saved && saved in KIOSKS) return saved as Kiosk;
  }
  catch { /* no storage: fall through to the default */ }
  return "ier-919";
}

const systemLine = (text: string): LogEntry => ({ at: "", device: "system", kind: "failed", text });

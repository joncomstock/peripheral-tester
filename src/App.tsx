import { useCallback, useEffect, useRef, useState } from "react";
import type { LogEntry, Snapshot } from "./api.ts";
import * as api from "./api.ts";
import type { DeviceId, WiredId } from "./devices.ts";
import { deviceEntry, isWired } from "./devices.ts";
import { Drawer } from "./Drawer.tsx";
import { clockTime } from "./format.ts";
import type { DrawerTab } from "./Drawer.tsx";
import { badgeClass, glyph, LAMP, lampStyle } from "./look.ts";
import { Planned } from "./Planned.tsx";
import { Rail } from "./Rail.tsx";
import { handshake, runSweep } from "./sweep.ts";
import type { SweepResult, SweepResults } from "./sweep.ts";
import { applyTheme, loadTheme } from "./theme.ts";
import type { Theme } from "./theme.ts";
import { Toasts, useToasts } from "./Toasts.tsx";
import { CardReaderPage } from "./CardReaderPage.tsx";
import { PassportReaderPage } from "./PassportReaderPage.tsx";
import { LightBoardPage, phrase as lightboardPhrase } from "./LightBoardPage.tsx";

const MAX_LINES = 200;

/**
 * The shell: which device is on screen, and the state every screen shares.
 *
 * One connection to the backend and one event stream serve every device. The rail down the side
 * holds every peripheral a 919 has; a device page renders the controls for its own and nothing
 * else, including the connection strip above them.
 */
export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [view, setView] = useState<DeviceId>("lightboard");
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [drawer, setDrawer] = useState<DrawerTab | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [results, setResults] = useState<SweepResults>({});
  const [sweeping, setSweeping] = useState(false);
  const [testing, setTesting] = useState<DeviceId | null>(null);
  const { toasts, toast, dismiss } = useToasts();
  /** Set once the stream has supplied a snapshot, after which the initial fetch is stale. */
  const hydrated = useRef(false);
  /** The sweep runs across awaits and needs the snapshot as it is *now*, not as it was when it started. */
  const latest = useRef<Snapshot | null>(null);
  latest.current = snapshot;

  useEffect(() => applyTheme(theme), [theme]);

  /**
   * Escape closes whatever is on top.
   *
   * One handler rather than one per overlay: the settings panel can sit over the drawer, and two
   * independent listeners would have closed both with a single press.
   */
  useEffect(() => {
    const closeTopmost = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (settingsOpen) setSettingsOpen(false);
      else setDrawer(null);
    };
    document.addEventListener("keydown", closeTopmost);
    return () => document.removeEventListener("keydown", closeTopmost);
  }, [settingsOpen]);

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
          // Named per device rather than defaulting: "anything that is not the light board is the
          // card reader" held with two devices and stopped holding at three. A fourth would have
          // been written into `cardreader`, rendering another peripheral's fields on its page.
          // Naming each also lets the discriminated union narrow, so neither cast is needed.
          if (event.device === "lightboard") {
            return { ...previous, lightboard: { ...previous.lightboard, ...event.state } };
          }
          if (event.device === "cardreader") return { ...previous, cardreader: event.state };
          if (event.device === "passportreader") return { ...previous, passportreader: event.state };
          return previous;
        });
      },
      (message) => setLog((previous) => [...previous, systemLine("failed", message)].slice(-MAX_LINES)),
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
    setLog((previous) => [...previous, systemLine("failed", message)].slice(-MAX_LINES));
    toast(message, "bad");
  }, [toast]);

  /**
   * A handshake result, into the log the rest of the tester writes to.
   *
   * The sweep runs in the browser, so the backend never sees it — without this its outcome lived
   * only in the notice bar and the rail, and vanished on the next sweep. Putting it in Activity is
   * what makes it survive, get filtered, and land in an export alongside everything else.
   */
  const record = useCallback((id: WiredId, result: SweepResult) => {
    const text = `Handshake ${result.pass ? "passed" : "failed"} — ${result.detail}`;
    // Tagged with the device, not `system`: the log's "this device" filter is the reason the tag
    // exists, and three handshakes filed under `system` showed all three on every screen.
    setLog((previous) => [
      ...previous,
      { at: clockTime(), device: id, kind: result.pass ? "ok" : "error", text },
    ].slice(-MAX_LINES));
  }, []);

  const sweep = useCallback(async () => {
    const held = latest.current;
    if (!held || sweeping) return;
    setSettingsOpen(false);
    setSweeping(true);
    setResults({});
    const outcome: SweepResults = {};
    await runSweep(
      () => latest.current ?? held,
      (id, result) => {
        outcome[id] = result;
        setResults((previous) => ({ ...previous, [id]: result }));
        record(id, result);
      },
      setTesting,
    );
    setSweeping(false);
    const failures = Object.values(outcome).filter((result) => !result.pass).length;
    const total = Object.keys(outcome).length;
    toast(
      failures === 0 ? `Handshake passed — ${total} of ${total}` : `${failures} of ${total} refused`,
      failures === 0 ? "ok" : "bad",
    );
  }, [sweeping, toast, record]);

  const retest = useCallback(async () => {
    const held = latest.current;
    if (!held || sweeping || !isWired(view)) return;
    setTesting(view);
    const result = await handshake(view, held);
    setResults((previous) => ({ ...previous, [view]: result }));
    record(view, result);
    setTesting(null);
  }, [sweeping, view, record]);

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

  const entry = deviceEntry(view);
  const result = isWired(view) ? results[view] : undefined;
  const failures = Object.values(results).filter((each) => !each.pass).length;

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <span className="mark" />
          <span className="brand-text">
            <span className="brand-name">Peripheral Tester</span>
            <span className="brand-model">{entry.name} · {entry.model}</span>
          </span>
        </div>

        {snapshot.mock && <span className={badgeClass("warn")}>Mock devices</span>}

        <button className={failures ? "pill pill--bad" : "pill"} onClick={() => setDrawer("bus")}>
          Bus{failures > 0 && <span className="pill-count">{failures} refused</span>}
        </button>
        <button className="pill" onClick={() => setDrawer("activity")}>
          Activity{log.length > 0 && <span className="pill-count">{log.length}</span>}
        </button>
        <button
          className={settingsOpen ? "icon-button icon-button--on" : "icon-button"}
          onClick={() => setSettingsOpen((was) => !was)}
          title="Tester settings"
          aria-label="Tester settings"
          aria-expanded={settingsOpen}
        >
          ⚙{failures > 0 && <span className="icon-dot" />}
        </button>
      </header>

      {settingsOpen && (
        <Settings
          theme={theme}
          sweeping={sweeping}
          results={results}
          onTheme={setTheme}
          onSweep={sweep}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <div className="body">
        <Rail
          snapshot={snapshot}
          current={view}
          results={results}
          testing={testing}
          collapsed={railCollapsed}
          onOpen={setView}
          onToggle={() => setRailCollapsed((was) => !was)}
        />

        <div className="workspace">
          {result && (
            <div className={result.pass ? "notice notice--ok" : "notice notice--bad"}>
              <span style={lampStyle(result.pass ? LAMP.green : LAMP.red, "on", 12)} />
              <span className="notice-text">
                {glyph(result.pass ? "ok" : "bad")}
                Handshake {result.pass ? "passed" : "failed"} at {result.at} — {result.detail}
              </span>
              <button className="pill" disabled={sweeping || testing !== null} onClick={retest}>Re-test this device</button>
            </div>
          )}

          {view === "lightboard" && <LightBoardPage state={snapshot.lightboard} onFail={fail} toast={toast} />}
          {view === "cardreader" && <CardReaderPage state={snapshot.cardreader} onFail={fail} toast={toast} />}
          {view === "passportreader" && <PassportReaderPage state={snapshot.passportreader} onFail={fail} toast={toast} />}
          {!entry.ready && <Planned entry={entry} />}
        </div>
      </div>

      {drawer && (
        <Drawer
          tab={drawer}
          snapshot={snapshot}
          log={log}
          view={view}
          results={results}
          sweeping={sweeping}
          phrase={lightboardPhrase}
          onTab={setDrawer}
          onClose={() => setDrawer(null)}
          testing={testing}
          onSweep={sweep}
          onClear={() => {
            setLog([]);
            toast("Activity cleared", "warn");
          }}
          toast={toast}
        />
      )}

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

/** Appearance, and the one action that is about the whole kiosk rather than one device. */
function Settings(
  { theme, sweeping, results, onTheme, onSweep, onClose }: {
    theme: Theme;
    sweeping: boolean;
    results: SweepResults;
    onTheme: (theme: Theme) => void;
    onSweep: () => void;
    onClose: () => void;
  },
) {
  const done = Object.values(results);
  const failures = done.filter((result) => !result.pass).length;
  // The most recent attempt of any of them: a pass from twenty minutes ago is worth distrusting.
  const lastRun = done.map((result) => result.at).sort().pop();

  return (
    <div className="popover-layer">
      <button className="popover-scrim" onClick={onClose} aria-label="Close settings" />
      <div className="popover" role="dialog" aria-modal="true" aria-label="Tester settings">
        <div className="card-head">
          <span className="tab" />
          <h2>Tester settings</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">✕</button>
        </div>

        <div className="setting">
          <span className="setting-label">Appearance</span>
          <div className="seg seg--small" data-enabled="true">
            <button className={theme === "light" ? "chooser chooser-on" : "chooser"} onClick={() => onTheme("light")}>
              Light
            </button>
            <button className={theme === "dark" ? "chooser chooser-on" : "chooser"} onClick={() => onTheme("dark")}>
              Dark
            </button>
          </div>
        </div>

        <div className="setting setting--stacked">
          <div className="setting-line">
            <span
              style={lampStyle(failures ? LAMP.red : LAMP.green, sweeping ? "pulse" : done.length ? "on" : "off", 12)}
            />
            <span className="setting-label">Health sweep</span>
            <button className="pill pill--primary" disabled={sweeping} onClick={onSweep}>
              {sweeping ? "Sweeping…" : done.length ? "Again" : "Run sweep"}
            </button>
          </div>
          <span className="setting-note">
            {sweeping
              ? "Claiming each wired device in turn."
              : done.length === 0
              ? "Opens and handshakes every wired device without driving it. A device you already have open is left open."
              : failures === 0
              ? `All ${done.length} answered at ${lastRun}. The device pane carries the detail.`
              : `${failures} of ${done.length} refused at ${lastRun} — the device pane carries the detail.`}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * A line the browser wrote rather than the backend.
 *
 * Stamped from this clock, in the same `HH:MM:SS` the backend uses. An earlier version left the
 * time blank on the theory that a second clock would order things wrongly — but the backend is on
 * loopback, so it is the same clock, and a blank column in the middle of the log (and in an export
 * of it) was the only thing that actually went wrong.
 */
const systemLine = (kind: string, text: string): LogEntry => ({
  at: clockTime(),
  device: "system",
  kind,
  text,
});

import { useCallback, useEffect, useRef, useState } from "react";
import type { LogEntry, Snapshot } from "./api.ts";
import * as api from "./api.ts";
import type { DeviceId, WiredId } from "./devices.ts";
import { absenceOf, DEFAULT_DEVICES, DEVICES, deviceEntry, isDeviceId, isWired, kioskOf, statusOf, WIRED } from "./devices.ts";
import { DevicePicker } from "./DevicePicker.tsx";
import { useDialog } from "./dialog.ts";
import { Drawer } from "./Drawer.tsx";
import { clockTime } from "./format.ts";
import type { DrawerTab } from "./Drawer.tsx";
import { badgeClass, glyph, LAMP, lampStyle } from "./look.ts";
import { Planned } from "./Planned.tsx";
import { Unavailable } from "./Unavailable.tsx";
import { Rail } from "./Rail.tsx";
import { handshake, runSweep } from "./sweep.ts";
import type { SweepResult, SweepResults } from "./sweep.ts";
import { applyTheme, loadTheme, recall, recallSet, remember } from "./prefs.ts";
import type { Theme } from "./prefs.ts";
import { Toasts, useToasts } from "./Toasts.tsx";
import { CardReaderPage } from "./CardReaderPage.tsx";
import { PassportReaderPage } from "./PassportReaderPage.tsx";
import { LightBoardPage, phrase as lightboardPhrase } from "./LightBoardPage.tsx";

const MAX_LINES = 200;

/**
 * How far down a rail of `rows` the number keys reach.
 *
 * A keydown carries one key, so there is no two-digit form to support and a longer rail is
 * reachable by key only as far as its ninth row. A function rather than a constant because the
 * handler and the shortcut sheet have to agree on the answer, not merely on the nine: two copies
 * of the same clamp is the same defect one step along.
 */
const keyedRows = (rows: number) => Math.min(rows, 9);

type RailState = "open" | "collapsed";
const isRailState = (value: string): value is RailState => value === "open" || value === "collapsed";

/**
 * What each key does, shown by `?` and the single place the handler's behaviour is described.
 *
 * `reach` is how far down the rail the number keys get, which is now a property of the *chosen*
 * rail rather than of the catalogue — and is capped at nine by the keyboard, not by us.
 */
const shortcuts = (reach: number): { keys: string; does: string }[] => [
  { keys: reach === 1 ? "1" : `1 – ${reach}`, does: "Open that device from the rail, in the order it is listed" },
  { keys: "[", does: "Collapse or expand the rail" },
  { keys: "Enter", does: "Fire the open screen's primary action, when it has one" },
  { keys: "Esc", does: "Close whatever is on top — this sheet, then the device picker, then settings, then the drawer" },
  { keys: "?", does: "Show this" },
];

/**
 * The shell: which device is on screen, and the state every screen shares.
 *
 * One connection to the backend and one event stream serve every device. The rail down the side
 * holds the peripherals this bench chose to test; a device page renders the controls for its own
 * and nothing else, including the connection strip above them.
 */
export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [device, setDevice] = useState<DeviceId>(() => recall("device", "lightboard", isDeviceId));
  const [selected, setSelected] = useState<DeviceId[] | null>(() => recallSet("devices", isDeviceId));
  /*
   * Where the device picker was opened from, which is also whether it is open at all.
   *
   * Not a boolean plus `selected === null`: read that way the sheet closed itself on the very
   * first tick, because ticking is what stops `selected` being null. And not a boolean plus a
   * separate first-run flag, because the two can disagree — this is one fact.
   */
  // `selected` is already bound by the time this initialiser runs, so storage is read once.
  const [picker, setPicker] = useState<"landing" | "settings" | null>(() => selected === null ? "landing" : null);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [drawer, setDrawer] = useState<DrawerTab | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => recall("rail", "open", isRailState) === "collapsed");
  const [results, setResults] = useState<SweepResults>({});
  const [sweeping, setSweeping] = useState(false);
  const [testing, setTesting] = useState<DeviceId | null>(null);
  const { toasts, toast, dismiss } = useToasts();
  /** Set once the stream has supplied a snapshot, after which the initial fetch is stale. */
  const hydrated = useRef(false);
  /** The sweep runs across awaits and needs the snapshot as it is *now*, not as it was when it started. */
  const latest = useRef<Snapshot | null>(null);
  latest.current = snapshot;

  /**
   * What the rail carries, and which of it is on screen.
   *
   * `view` is derived rather than held, so it cannot name a device the rail is not showing. Held in
   * state it would need an effect to correct it after every change to the selection, and that
   * effect renders once with the old value — one frame of a screen for a device that is no longer
   * there, on the exact press that removed it.
   *
   * `chosen` is never empty: `recallSet` reads an empty stored set as "never chosen", every kiosk
   * preset has at least one device, and `toggleDevice` refuses to remove the last one.
   */
  const chosen = selected ?? DEFAULT_DEVICES;
  const shown = DEVICES.filter((entry) => chosen.includes(entry.id));
  const view = shown.some((entry) => entry.id === device) ? device : shown[0].id;
  const railIds = shown.map((entry) => entry.id);
  /** The devices on the rail this backend holds a handle for — what the sweep and the Bus tab act on. */
  const wired = railIds.filter(isWired);
  const picking = picker !== null;

  /** The rail as it is *now*, for the key handler and the sweep, which both outlive this render. */
  const rail = useRef<DeviceId[]>([]);
  rail.current = railIds;

  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => remember("device", view), [view]);
  useEffect(() => remember("rail", railCollapsed ? "collapsed" : "open"), [railCollapsed]);
  useEffect(() => {
    if (selected) remember("devices", selected.join(","));
  }, [selected]);

  /**
   * A new selection, and the handshakes it invalidates.
   *
   * A refusal from a device that has just left the rail would go on being counted in the masthead
   * and in the gear's dot, about a device nobody can now see, open, or re-test.
   */
  const choose = useCallback((ids: DeviceId[]) => {
    setSelected(ids);
    setResults((was) => {
      const kept: SweepResults = {};
      for (const id of ids) if (isWired(id) && was[id]) kept[id] = was[id];
      return kept;
    });
  }, []);

  /**
   * Closing the picker, which on a first landing is also what commits the default.
   *
   * The sheet has no Cancel — every tick has already applied to the rail behind it — so the only
   * thing left for a close to mean is "yes, these". On a first landing that is the default set the
   * rail is already showing, so accepting it by dismissal is what the screen was saying anyway.
   */
  const closePicker = useCallback(() => {
    setSelected((was) => was ?? DEFAULT_DEVICES);
    setPicker(null);
  }, []);

  /**
   * The keyboard.
   *
   * One handler for all of it, rather than one per overlay: two independent listeners would have
   * closed both with a single press. Only one overlay can actually be open at a time — each scrims
   * the masthead and traps Tab — so the order below is belt and braces rather than a live case,
   * and the rest must not fire while any of them is open: a number key that switched device out
   * from under an open drawer would leave it describing a screen nobody is looking at.
   *
   * Deliberately no modifier keys. This is driven one-handed while the other hand holds a card.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (shortcutsOpen) setShortcutsOpen(false);
        else if (picking) closePicker();
        else if (settingsOpen) setSettingsOpen(false);
        else setDrawer(null);
        return;
      }
      /*
       * Never steal a key from something being typed into, and never from an overlay.
       *
       * `instanceof Element` rather than a cast: a keydown's target is normally the focused
       * element, but it is `document` when nothing is focused and when one is dispatched
       * programmatically — and `document.closest` does not exist, so casting turned every
       * shortcut into a TypeError in exactly the state the shortcuts are for.
       */
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (shortcutsOpen || settingsOpen || picking || drawer) return;

      if (event.key === "?") {
        setShortcutsOpen(true);
        return;
      }
      if (event.key === "[") {
        setRailCollapsed((was) => !was);
        return;
      }
      if (event.key === "Enter") {
        // Not when a control already has focus — Enter belongs to that control, and firing both
        // would send a device two commands from one press.
        if (target?.closest("button, a, [role='button']")) return;
        /*
         * "The primary action" is defined as the button drawn primary, found rather than declared.
         * A page that says which of its buttons is primary can disagree with the page; the one it
         * renders that way cannot. Scoped to the workspace so the rail is out of reach, and
         * `:not([disabled])` means this can never fire a command the screen is refusing.
         */
        document.querySelector<HTMLButtonElement>(".workspace .button--primary:not([disabled])")?.click();
        return;
      }
      const slot = Number(event.key);
      if (Number.isInteger(slot) && slot >= 1 && slot <= keyedRows(rail.current.length)) {
        setDevice(rail.current[slot - 1]);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [settingsOpen, drawer, shortcutsOpen, picking, closePicker]);

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
          // A device with no driver in this checkout has no slice to update, and never emits one.
          // Guarded rather than asserted: the stream is the backend talking, not this file.
          // Named per device rather than defaulting: "anything that is not the light board is the
          // card reader" held with two devices and stopped holding at three. A fourth would have
          // been written into `cardreader`, rendering another peripheral's fields on its page.
          // Naming each also lets the discriminated union narrow, so neither cast is needed.
          if (event.device === "lightboard") {
            if (!previous.lightboard) return previous;
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

  /** See where it is written, below the snapshot guard — this only holds the value. */
  const idleLine = useRef<Partial<Record<WiredId, LogEntry | undefined>>>({});

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
    // Only what the rail is showing. The sweep claims handles for real, so a bench that took the
    // card reader off the rail should not have this open it. Both entry points already disable
    // themselves on an empty list; this is what makes that a fact rather than a rendering.
    const ids = rail.current.filter(isWired);
    if (ids.length === 0) return;
    setSettingsOpen(false);
    setSweeping(true);
    setResults({});
    const outcome: SweepResults = {};
    await runSweep(
      ids,
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

  /** The newest line each device has produced, in one pass rather than three. */
  const newest: Partial<Record<WiredId, LogEntry>> = {};
  for (let i = log.length - 1; i >= 0; i--) {
    const line = log[i];
    // `system` lines belong to no device and are never a connect stage.
    if (line.device !== "system" && newest[line.device] === undefined) newest[line.device] = line;
  }

  /**
   * The line each device had last produced while it was *not* opening.
   *
   * Recorded on every render that finds the device idle, rather than on the transition into
   * opening: the stream delivers the new status and the first stage line as two messages React
   * frequently batches into one render, so a mark taken when opening is first *seen* is already
   * past the line it was meant to include. Lagging it cannot race the batch — a render where the
   * device is opening never moves it.
   *
   * The entry itself, not its index. `log` is a sliding window capped at `MAX_LINES`, so once a
   * session fills it every index is 200 forever and an index comparison silently stops matching
   * anything — the stage line would work all morning and then quietly never appear again.
   */
  for (const id of WIRED) if (statusOf(snapshot, id) !== "opening") idleLine.current[id] = newest[id];

  /**
   * The newest line this device has produced since it began opening, for the connection strip.
   *
   * Compared by identity against the line it had before, because the newest line a device has
   * *ever* produced is, on a reconnect, the previous session's "Reader released" — a stale line
   * presented as the stage the device is at now.
   *
   * Phrased, because the light board records a command as the request it put on the wire.
   */
  const progress = (() => {
    if (!isWired(view) || statusOf(snapshot, view) !== "opening") return undefined;
    const line = newest[view];
    return line && line !== idleLine.current[view] ? lightboardPhrase(line) : undefined;
  })();

  const entry = deviceEntry(view);
  const absence = absenceOf(snapshot, view);
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
          className="icon-button"
          onClick={() => setShortcutsOpen(true)}
          data-tip="Keyboard shortcuts"
          aria-label="Keyboard shortcuts"
        >
          ?
        </button>
        <button
          className={settingsOpen ? "icon-button icon-button--on" : "icon-button"}
          onClick={() => setSettingsOpen((was) => !was)}
          data-tip="Tester settings"
          aria-label="Tester settings"
          aria-expanded={settingsOpen}
        >
          ⚙{failures > 0 && <span className="icon-dot" />}
        </button>
      </header>

      {shortcutsOpen && <Shortcuts reach={keyedRows(shown.length)} onClose={() => setShortcutsOpen(false)} />}

      {picking && (
        <DevicePicker
          selected={chosen}
          firstRun={picker === "landing"}
          onSelect={choose}
          onClose={closePicker}
          toast={toast}
        />
      )}

      {settingsOpen && (
        <Settings
          theme={theme}
          chosen={chosen}
          claimable={wired.length}
          sweeping={sweeping}
          results={results}
          onTheme={setTheme}
          onSweep={sweep}
          onDevices={() => {
            setSettingsOpen(false);
            setPicker("settings");
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <div className="body">
        <Rail
          snapshot={snapshot}
          devices={shown}
          current={view}
          results={results}
          testing={testing}
          collapsed={railCollapsed}
          onOpen={setDevice}
          onToggle={() => setRailCollapsed((was) => !was)}
        />

        <div className="workspace">
          {result && (
            <div className={result.pass ? "notice notice--ok" : "notice notice--bad"}>
              <span data-lamp="" style={lampStyle(result.pass ? LAMP.green : LAMP.red, "on", 12)} />
              <span className="notice-text">
                {glyph(result.pass ? "ok" : "bad")}
                Handshake {result.pass ? "passed" : "failed"} at {result.at} — {result.detail}
              </span>
              <button className="pill" disabled={sweeping || testing !== null} onClick={retest}>Re-test this device</button>
            </div>
          )}

          {/*
            * Absence first: a device whose driver the backend could not load has no state to hand a
            * screen, so its page cannot render at all — and the reason is worth a pane of its own.
            */}
          {absence !== undefined && <Unavailable entry={entry} reason={absence} />}
          {view === "lightboard" && snapshot.lightboard && (
            <LightBoardPage state={snapshot.lightboard} onFail={fail} toast={toast} progress={progress} />
          )}
          {view === "cardreader" && snapshot.cardreader && (
            <CardReaderPage state={snapshot.cardreader} onFail={fail} toast={toast} progress={progress} />
          )}
          {view === "passportreader" && snapshot.passportreader && (
            <PassportReaderPage state={snapshot.passportreader} onFail={fail} toast={toast} progress={progress} />
          )}
          {!entry.ready && <Planned entry={entry} />}
        </div>
      </div>

      {drawer && (
        <Drawer
          tab={drawer}
          snapshot={snapshot}
          wired={wired}
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

/** What the keyboard does. Opened with `?`, and the only place a shortcut is discoverable. */
function Shortcuts({ reach, onClose }: { reach: number; onClose: () => void }) {
  const panel = useDialog<HTMLDivElement>();
  /**
   * What Enter would do right now, read from the screen behind this sheet.
   *
   * Read rather than declared, for the same reason the handler finds the button rather than being
   * told about it — the same selector, so the sheet cannot disagree with the key. Shown because
   * Enter is genuinely inert on a connected light board, which has thirty equal controls and no
   * one primary among them: a key that sometimes does nothing should say when.
   *
   * Read on every render, not once on mount. This re-renders with the shell, so a connect that
   * lands while the sheet is open updates it — held in state it would have gone on describing the
   * screen as it was when the sheet opened.
   */
  const primary = document.querySelector<HTMLButtonElement>(".workspace .button--primary:not([disabled])")
    ?.textContent?.trim();

  return (
    <div className="popover-layer">
      <button className="popover-scrim" onClick={onClose} aria-label="Close the shortcut sheet" />
      <div className="popover popover--centred" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" ref={panel}>
        <div className="card-head">
          <span className="tab" />
          <h2>Keyboard</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close the shortcut sheet">✕</button>
        </div>
        <div className="fieldlist">
          {shortcuts(reach).map(({ keys, does }) => (
            <div className="fieldrow" key={keys}>
              <span className="fieldrow-label"><kbd>{keys}</kbd></span>
              <span className="fieldrow-value">
                {does}
                {keys === "Enter" && (
                  <span className="tone-muted">
                    {primary ? ` — right now, ${primary}` : " — this screen has none right now"}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
        <p className="masknote">
          No modifiers, and nothing fires while a panel is open or while you are typing in the port
          field — this is driven one-handed with a card in the other.
        </p>
      </div>
    </div>
  );
}

/** Appearance, and the one action that is about the whole kiosk rather than one device. */
function Settings(
  { theme, chosen, claimable, sweeping, results, onTheme, onSweep, onDevices, onClose }: {
    theme: Theme;
    chosen: DeviceId[];
    /** How many devices on the rail this backend can open — the sweep has nothing to do at zero. */
    claimable: number;
    sweeping: boolean;
    results: SweepResults;
    onTheme: (theme: Theme) => void;
    onSweep: () => void;
    onDevices: () => void;
    onClose: () => void;
  },
) {
  const panel = useDialog<HTMLDivElement>();
  const done = Object.values(results);
  const failures = done.filter((result) => !result.pass).length;
  // The most recent attempt of any of them: a pass from twenty minutes ago is worth distrusting.
  const lastRun = done.map((result) => result.at).sort().pop();
  const kiosk = kioskOf(chosen);

  return (
    <div className="popover-layer">
      <button className="popover-scrim" onClick={onClose} aria-label="Close settings" />
      <div className="popover" role="dialog" aria-modal="true" aria-label="Tester settings" ref={panel}>
        <div className="card-head">
          <span className="tab" />
          <h2>Tester settings</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">✕</button>
        </div>

        <div className="setting">
          <span className="setting-label">Devices</span>
          <span className="chip">{kiosk ? kiosk.name : `${chosen.length} of ${DEVICES.length}`}</span>
          <button className="pill" onClick={onDevices}>Choose…</button>
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
              data-lamp=""
              style={lampStyle(failures ? LAMP.red : LAMP.green, sweeping ? "pulse" : done.length ? "on" : "off", 12)}
            />
            <span className="setting-label">Health sweep</span>
            <button className="pill pill--primary" disabled={sweeping || claimable === 0} onClick={onSweep}>
              {sweeping ? "Sweeping…" : done.length ? "Again" : "Run sweep"}
            </button>
          </div>
          <span className="setting-note">
            {claimable === 0
              ? "Nothing on the rail has a driver bound to this backend, so there is nothing to handshake."
              : sweeping
              ? "Claiming each wired device in turn."
              : done.length === 0
              ? `Opens and handshakes ${claimable === 1 ? "the one wired device" : `all ${claimable} wired devices`} ` +
                "on the rail without driving them. A device you already have open is left open."
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

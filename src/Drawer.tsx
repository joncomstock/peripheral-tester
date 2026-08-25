import type { LogEntry, Snapshot } from "./api.ts";
import { useDialog } from "./dialog.ts";
import { Activity } from "./Activity.tsx";
import type { DeviceId } from "./devices.ts";
import { busLine, deviceEntry, isLive, verdict, WIRED } from "./devices.ts";
import { badgeClass, glyph, lampStyle } from "./look.ts";
import type { Tone } from "./look.ts";
import type { SweepResults } from "./sweep.ts";

export type DrawerTab = "activity" | "bus";

/**
 * The side drawer: the log, and what is on the bus.
 *
 * Both used to be panels competing with the controls for the same column. They are reference
 * rather than control — consulted when something has gone wrong, not while driving a device — so
 * they moved off the screen and the whole width went to the peripherals.
 */
export function Drawer(
  { tab, snapshot, log, view, results, sweeping, testing, phrase, onTab, onClose, onSweep, onClear, toast }: {
    tab: DrawerTab;
    snapshot: Snapshot;
    log: LogEntry[];
    view: DeviceId;
    results: SweepResults;
    sweeping: boolean;
    /** The device being handshaked right now, so the bus list and the rail cannot disagree. */
    testing: DeviceId | null;
    phrase?: (entry: LogEntry) => string;
    onTab: (tab: DrawerTab) => void;
    onClose: () => void;
    onSweep: () => void;
    onClear: () => void;
    toast: (text: string, tone?: Tone) => void;
  },
) {
  // Escape is handled once, in `App`, because it has to close the settings panel before this.
  const panel = useDialog<HTMLDivElement>();
  return (
    <div className="drawer-layer">
      <button className="drawer-scrim" onClick={onClose} aria-label="Close the drawer" />
      <div className="drawer" role="dialog" aria-modal="true" aria-label="Activity and bus" ref={panel}>
        <div className="drawer-head">
          <div className="seg seg--small" data-enabled="true">
            <button className={tab === "activity" ? "chooser chooser-on" : "chooser"} onClick={() => onTab("activity")}>
              Activity
            </button>
            <button className={tab === "bus" ? "chooser chooser-on" : "chooser"} onClick={() => onTab("bus")}>Bus</button>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {tab === "activity"
          ? <Activity log={log} view={view} phrase={phrase} onClear={onClear} toast={toast} />
          : <Bus snapshot={snapshot} results={results} sweeping={sweeping} testing={testing} onSweep={onSweep} />}
      </div>
    </div>
  );
}

/**
 * What is on the bus, and whether this process can claim it.
 *
 * Every row is the tester's own knowledge rather than an enumeration of the machine: nothing here
 * scans the USB tree or the registry, because claiming a handle is the only thing that actually
 * answers "can the driver have this device" — a device can be enumerated and still be held by the
 * wrong class driver. So the badges come from the health sweep, which claims for real.
 *
 * Only the wired three. A peripheral whose screen is not built has no handle for this process to
 * claim, so there is nothing here that could be said about it — the rail already lists all eight,
 * and saying "no driver bound" beside one whose driver is written was simply wrong.
 */
function Bus(
  { snapshot, results, sweeping, testing, onSweep }: {
    snapshot: Snapshot;
    results: SweepResults;
    sweeping: boolean;
    testing: DeviceId | null;
    onSweep: () => void;
  },
) {
  const failures = Object.values(results).filter((result) => !result.pass).length;

  return (
    <div className="bus">
      <div className="drawer-tools">
        <span className="drawer-note">
          {sweeping
            ? "Claiming each device in turn…"
            : Object.keys(results).length === 0
            ? "Not handshaked this session"
            : failures === 0
            ? "Every wired device answered"
            : `${failures} of ${Object.keys(results).length} refused`}
        </span>
        <button className="pill pill--primary" disabled={sweeping} onClick={onSweep}>
          {sweeping ? "Handshaking…" : "Handshake all"}
        </button>
      </div>

      {WIRED.map((id) => {
        const result = results[id];
        const { tone, text, mode, color } = verdict({
          ready: true,
          live: isLive(snapshot, id),
          testing: testing === id,
          pass: result?.pass,
        });
        return (
          <div className="bus-row" key={id}>
            <span data-lamp="" style={lampStyle(color, mode, 14)} />
            <span className="bus-address">{busLine(snapshot, id)}</span>
            <span className="bus-name">{deviceEntry(id).model}</span>
            <span className={badgeClass(tone)}>{glyph(tone)}{text}</span>
            {result && !result.pass && <span className="bus-detail">{result.detail}</span>}
            {/*
              * The one refusal worth explaining. A V4KU that is plugged in and still will not open
              * is almost always enumerating on the Windows HID class driver, and `OmronV4KU.open()`
              * claims the interface directly — so nothing this tester does will help until the
              * device is rebound. Shown only on the refusal, so it is guidance rather than chrome.
              */}
            {id === "cardreader" && result && !result.pass && (
              <span className="bus-detail">
                If the reader is plugged in, the usual cause is the Windows HID class driver holding
                the interface. Rebind it to WinUSB or libusbK with Zadig and handshake again.
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

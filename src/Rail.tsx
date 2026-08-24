import type { Snapshot } from "./api.ts";
import type { DeviceEntry, DeviceId } from "./devices.ts";
import { busLine, DEVICES, isLive, isWired, verdict } from "./devices.ts";
import { badgeClass, glyph, lampStyle } from "./look.ts";
import type { SweepResults } from "./sweep.ts";

/**
 * The device rail: every peripheral a 919 has, always on screen.
 *
 * It replaces the dashboard the tester used to open on. A dashboard is a place you go back to; a
 * rail is a place you are already in, and someone crouched at a kiosk moving between the card
 * reader and the light board should not have to leave one to reach the other. What was lost with
 * the dashboard — model, bus, connected-or-not — is on each row.
 *
 * Collapsing narrows it to lamps and initials, for a kiosk display that has no width to spare.
 */
export function Rail(
  { snapshot, current, results, testing, collapsed, onOpen, onToggle }: {
    snapshot: Snapshot;
    current: DeviceId;
    results: SweepResults;
    /** The device the sweep is handshaking right now, if one is. */
    testing: DeviceId | null;
    collapsed: boolean;
    onOpen: (id: DeviceId) => void;
    onToggle: () => void;
  },
) {
  return (
    <nav className={collapsed ? "rail rail--collapsed" : "rail"} aria-label="Devices">
      <div className="rail-head">
        <span className="rail-title">Devices</span>
        <span className="chip">{DEVICES.length} total</span>
        <button
          className="rail-toggle"
          onClick={onToggle}
          title={collapsed ? "Expand the device rail" : "Collapse the device rail"}
          aria-label={collapsed ? "Expand the device rail" : "Collapse the device rail"}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>
      <div className="rail-scroll">
        {DEVICES.map((entry) => (
          <RailRow
            key={entry.id}
            entry={entry}
            snapshot={snapshot}
            selected={entry.id === current}
            result={isWired(entry.id) ? results[entry.id] : undefined}
            testing={testing === entry.id}
            onOpen={onOpen}
          />
        ))}
      </div>
    </nav>
  );
}

function RailRow(
  { entry, snapshot, selected, result, testing, onOpen }: {
    entry: DeviceEntry;
    snapshot: Snapshot;
    selected: boolean;
    result?: { pass: boolean; detail: string };
    testing: boolean;
    onOpen: (id: DeviceId) => void;
  },
) {
  const live = isLive(snapshot, entry.id);
  const { tone, text, mode, color } = verdict({ ready: entry.ready, live, testing, pass: result?.pass });
  const initials = entry.name.split(" ").map((word) => word[0]).join("").slice(0, 2).toUpperCase();
  // A sweep's own words when it has some, because "Fail" alone does not say what refused.
  const sub = result ? result.detail : testing ? "Handshaking…" : busLine(snapshot, entry.id);

  return (
    <button
      className={selected ? "rail-row rail-row--on" : "rail-row"}
      onClick={() => onOpen(entry.id)}
      aria-current={selected ? "true" : undefined}
      title={`${entry.name} · ${entry.model} · ${text}`}
    >
      <span style={lampStyle(color, mode, 14)} />
      <span className="rail-initials">{initials}</span>
      <span className="rail-text">
        <span className="rail-name">{entry.name}</span>
        <span className="rail-sub">{sub}</span>
      </span>
      <span className={badgeClass(tone)}>{glyph(tone)}{text}</span>
    </button>
  );
}

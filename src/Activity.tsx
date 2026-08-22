import { useMemo } from "react";
import type { Device, LogEntry } from "./api.ts";
import { toneOf } from "./look.ts";
import { Card } from "./ui.tsx";

/**
 * The activity log, shared by every device.
 *
 * One log tagged by device rather than one per device: an operator working through a kiosk moves
 * between peripherals, and the order things happened in is what is worth reading. A device screen
 * shows its own lines; the dashboard shows all of them.
 *
 * `phrase` lets a device render its own lines in its own words — the light board records a command
 * as the request it sent, which is a wire shape rather than a sentence.
 */
export function Activity(
  { log, only, phrase, onClear }: {
    log: LogEntry[];
    /** Show one device's lines, or every line when omitted. */
    only?: Device;
    phrase?: (entry: LogEntry) => string;
    onClear: () => void;
  },
) {
  // Phrased and reversed once per new line rather than on every render: phrasing a light board
  // command parses its JSON, so doing it inline re-parsed the whole log on every unrelated change.
  const lines = useMemo(
    () =>
      log
        .filter((entry) => (only ? entry.device === only || entry.device === "system" : true))
        .map((entry) => ({
          at: entry.at,
          device: entry.device,
          tone: toneOf(entry.kind),
          text: phrase ? phrase(entry) : entry.text,
        }))
        .reverse(),
    [log, only, phrase],
  );

  return (
    <Card title="Activity" grow={1} action={<button className="clear" onClick={onClear}>Clear</button>}>
      <div className="activity">
        {lines.length === 0
          ? <div className="activity-empty">Nothing yet.</div>
          : lines.map((entry, index) => (
            <div className="activity-line" key={index}>
              <span className="activity-time">{entry.at}</span>
              {!only && entry.device !== "system" && (
                <span className={`activity-device activity-device--${entry.device}`}>
                  {entry.device === "lightboard" ? "board" : "reader"}
                </span>
              )}
              <span className={`activity-text tone-${entry.tone}`}>{entry.text}</span>
            </div>
          ))}
      </div>
    </Card>
  );
}

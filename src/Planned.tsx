import type { DeviceEntry } from "./devices.ts";
import { badgeClass } from "./look.ts";

/**
 * A peripheral this tester cannot drive yet.
 *
 * Shown rather than hidden, and specific about *why*: for nearly all of these the driver is
 * written and only the screen is missing, which is a very different thing from the payment
 * terminal, where no hardware has been chosen. Someone standing at a kiosk asking "can I test
 * this" gets an answer either way, and it names the package so the next person knows where the
 * work is.
 *
 * Deliberately no count. The catalogue grows whenever `hardware-libs` gains a driver, and a
 * number written here is wrong from that commit on, with nothing to catch it.
 */
export function Planned({ entry }: { entry: DeviceEntry }) {
  return (
    <div className="planned">
      <div className="planned-card">
        <span className={badgeClass(entry.pkg ? "warn" : "neutral")}>
          {entry.pkg ? "Driver written · screen pending" : "Not selected yet"}
        </span>
        <span className="planned-name">{entry.name}</span>
        <span className="planned-model">{entry.model}</span>
        <p className="planned-note">{entry.note}</p>
        <div className="planned-foot">
          <span className="setting-label">Driver</span>
          <span className="chip">{entry.pkg ?? "—"}</span>
          <span className="planned-bus">{entry.bus}</span>
        </div>
      </div>
    </div>
  );
}

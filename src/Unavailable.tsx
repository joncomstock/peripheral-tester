import type { DeviceEntry } from "./devices.ts";
import { badgeClass } from "./look.ts";

/**
 * A device this tester can drive, whose driver is not in the backend's checkout.
 *
 * Distinct from `Planned`, and the distinction is the whole point: `Planned` means nobody has built
 * a screen yet, and no amount of fiddling at the bench changes that. This means the screen exists
 * and the driver exists, but the backend is running against a `hardware-libs` branch that does not
 * carry it — which the person reading this can fix in a minute by switching branch and restarting.
 *
 * The driver's own words are quoted rather than summarised. "has no exported member 'DEFAULT_PORT'"
 * says the driver moved on and the backend has not followed; "not a dependency and not in import
 * map" says the package is not on this branch at all. Those are different jobs, and a friendlier
 * sentence would lose the difference.
 */
export function Unavailable({ entry, reason }: { entry: DeviceEntry; reason: string }) {
  return (
    <div className="planned">
      <div className="planned-card">
        <span className={badgeClass("warn")}>Driver not in this checkout</span>
        <span className="planned-name">{entry.name}</span>
        <span className="planned-model">{entry.model}</span>
        <p className="planned-note">
          The backend could not load this device's driver, so it is not offering the device. Point it
          at a <code>hardware-libs</code> checkout on the branch that carries{" "}
          <code>{entry.pkg ?? "the driver"}</code>, regenerate the local import map with{" "}
          <code>deno run --allow-read --allow-write scripts/localmap.ts</code>, and restart it.
        </p>
        <p className="masknote">{reason}</p>
        <div className="planned-foot">
          <span className="setting-label">Driver</span>
          <span className="chip">{entry.pkg ?? "—"}</span>
          <span className="planned-bus">{entry.bus}</span>
        </div>
      </div>
    </div>
  );
}

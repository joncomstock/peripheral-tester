import type { Snapshot } from "./api.ts";
import * as api from "./api.ts";
import { Card } from "./ui.tsx";

/**
 * Tester-wide settings. For now, one switch: simulate every device instead of opening real hardware,
 * for a demo away from a kiosk. Switching disconnects every device, so nothing opened in one mode
 * carries on in the other.
 */
export function Settings({ snapshot, onFail }: { snapshot: Snapshot; onFail: (message: string) => void }) {
  const set = (on: boolean) => api.settings.mock(on).catch((err: Error) => onFail(err.message));

  return (
    <Card title="Settings">
      <div className="settings">
        <div className="setting">
          <span className="setting-label">
            Mock devices
            <span className="setting-note">
              {snapshot.hardwareAllowed
                ? "Simulates every device. Switching disconnects them all."
                : "Real devices need FFI permission: restart with deno task dev."}
            </span>
          </span>
          <div className="seg" data-enabled role="group" aria-label="mock devices">
            <button
              className={snapshot.mock ? "chooser" : "chooser chooser-on"}
              aria-pressed={!snapshot.mock}
              disabled={!snapshot.hardwareAllowed}
              onClick={() => set(false)}
            >
              Off
            </button>
            <button className={snapshot.mock ? "chooser chooser-on" : "chooser"} aria-pressed={snapshot.mock} onClick={() => set(true)}>
              On
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}

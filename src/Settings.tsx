import { useRef, useState } from "react";
import type { Snapshot } from "./api.ts";
import * as api from "./api.ts";

type Theme = "dark" | "light";

/** Shared with the inline script in index.html, which applies the theme before the first paint. */
const THEME_KEY = "peripheral-tester.theme";

const currentTheme = (): Theme => document.documentElement.dataset.theme === "light" ? "light" : "dark";

/**
 * The settings modal, opened from a gear at the right of the header on every screen.
 *
 * A native `<dialog>`: `showModal` gives the focus trap, Escape to close and the inert page behind it
 * without any of that being reimplemented here.
 */
export function Settings({ snapshot, onFail }: { snapshot: Snapshot; onFail: (message: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const anyOpen = [snapshot.lightboard, snapshot.cardreader, snapshot.sankyo, snapshot.penta].some((device) => device.status !== "closed");

  const guard = (work: Promise<unknown>) => work.catch((err: Error) => onFail(err.message));

  const chooseTheme = (next: Theme) => {
    document.documentElement.dataset.theme = next;
    setTheme(next);
    // Remembered per browser. Storage may be unavailable; the choice still holds until reload.
    try {
      localStorage.setItem(THEME_KEY, next);
    }
    catch { /* see above */ }
  };

  return (
    <>
      <button className="gear" onClick={() => dialog.current?.showModal()} aria-label="Settings" title="Settings">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path
            fill="currentColor"
            d="M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.65 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.05.24.25.42.5.42h3.84c.25 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"
          />
        </svg>
      </button>

      <dialog ref={dialog} className="modal" aria-labelledby="settings-title" onClick={(event) => event.target === dialog.current && dialog.current?.close()}>
        <div className="card-head">
          <span className="tab" />
          <h2 id="settings-title">Settings</h2>
          <button className="clear" onClick={() => dialog.current?.close()} aria-label="Close settings">Close</button>
        </div>

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
                onClick={() => guard(api.settings.mock(false))}
              >
                Off
              </button>
              <button
                className={snapshot.mock ? "chooser chooser-on" : "chooser"}
                aria-pressed={snapshot.mock}
                onClick={() => guard(api.settings.mock(true))}
              >
                On
              </button>
            </div>
          </div>

          <div className="setting">
            <span className="setting-label">
              Theme
              <span className="setting-note">Remembered on this browser.</span>
            </span>
            <div className="seg" data-enabled role="group" aria-label="theme">
              {(["dark", "light"] as Theme[]).map((option) => (
                <button
                  key={option}
                  className={theme === option ? "chooser chooser-on" : "chooser"}
                  aria-pressed={theme === option}
                  onClick={() => chooseTheme(option)}
                >
                  {option === "dark" ? "Dark" : "Light"}
                </button>
              ))}
            </div>
          </div>

          <div className="setting">
            <span className="setting-label">
              Devices
              <span className="setting-note">Darkens and releases every connected device, as leaving a kiosk should.</span>
            </span>
            <button className="alloff" disabled={!anyOpen} onClick={() => guard(api.disconnectAll())}>
              Disconnect all
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}

import { useState } from "react";
import type { ReactNode } from "react";
import type { PentaSimulation, PentaState } from "./api.ts";
import * as api from "./api.ts";
import { lampColor, lampStyle } from "./look.ts";
import { Card } from "./ui.tsx";

const DOCUMENT_TEXT: Record<NonNullable<PentaState["document"]>, string> = {
  present: "A document is on the glass.",
  flipped: "The document was turned over.",
  removed: "The glass is clear.",
};

const SIMULATIONS: { action: PentaSimulation; label: string }[] = [
  { action: "passport", label: "Mock passport scan" },
  { action: "boarding-pass", label: "Mock boarding pass scan" },
  { action: "place", label: "Blank document" },
  { action: "flip", label: "Flip" },
  { action: "remove", label: "Remove" },
];

/**
 * The DESKO Penta's screen: what is on the glass and the last barcode the engine decoded, and the
 * scanner's lights and buzzer. The lights show what was commanded; the device does not report them.
 */
export function PentaPage(
  { state, onFail, aside }: { state: PentaState; onFail: (message: string) => void; aside: ReactNode },
) {
  const [flash, setFlash] = useState(false);
  const [about, setAbout] = useState<{ firmware: string; build: string; engine: string } | null>(null);
  const open = state.status === "open";
  const guard = (work: Promise<unknown>) => work.catch((err: Error) => onFail(err.message));
  const name = (color: string) => color[0].toUpperCase() + color.slice(1);

  return (
    <>
      <div className="col col-wide">
        <Card title="On the glass" aside="Reported" grow={3}>
          <div className="readpane">
            <div className="verdict">
              {!open
                ? "Connect the scanner to see what is placed on it."
                : state.document
                ? DOCUMENT_TEXT[state.document]
                : "Nothing reported since connecting. Place a document or a boarding pass."}
            </div>
            {state.passport && (
              <>
                <dl className="fields">
                  {([
                    ["Document", state.passport.documentType],
                    ["Issuing state", state.passport.issuingState],
                    ["Surname", state.passport.surname],
                    ["Given names", state.passport.givenNames],
                    ["Document number", state.passport.documentNumber],
                    ["Nationality", state.passport.nationality],
                    ["Date of birth", state.passport.birthDate],
                    ["Sex", state.passport.sex],
                    ["Expires", state.passport.expiryDate],
                  ] as const).map(([label, value]) => (
                    <div className="field" key={label}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="rawstripe">
                  <span className="setting-label">MRZ</span>
                  <code className="mrz">{state.passport.mrz.join("\n")}</code>
                </div>
                <p className="masknote">
                  Mock data. The Penta driver reads barcodes and reports documents on the glass, but not a
                  passport's MRZ: on a real kiosk this panel stays empty.
                </p>
              </>
            )}
            {state.barcode && (
              <dl className="fields">
                <div className="field">
                  <dt>Symbology</dt>
                  <dd>{state.barcode.symbology ?? "—"}</dd>
                </div>
                <div className="field">
                  <dt>Barcode</dt>
                  <dd className="barcode-text">{state.barcode.text}</dd>
                </div>
              </dl>
            )}
          </div>
        </Card>

        <Card title="Lights and sound" aside="Commanded" grow={3}>
          <div className="settings">
            <div className="setting">
              <span className="setting-label">Status LED</span>
              <div className="seg seg-wrap" data-enabled={open}>
                {state.ledColors.map((color) => {
                  const lit = state.statusLed?.color === color;
                  return (
                    <button
                      key={color}
                      className={lit ? "chooser chooser-on" : "chooser"}
                      disabled={!open}
                      onClick={() => guard(api.penta.statusLed(flash ? "flash" : "on", color))}
                    >
                      <span className="chooser-lamp" style={lampStyle(lampColor(color), lit ? state.statusLed!.mode === "flash" ? "blink" : "on" : "off", 12)} />
                      {name(color)}
                    </button>
                  );
                })}
                <button
                  className={state.statusLed === null ? "chooser chooser-on" : "chooser"}
                  disabled={!open}
                  onClick={() => guard(api.penta.statusLed("off"))}
                >
                  Off
                </button>
                <button
                  className={flash ? "chooser chooser-on" : "chooser"}
                  disabled={!open}
                  onClick={() => setFlash((was) => !was)}
                  aria-pressed={flash}
                  title="Apply the next colour flashing"
                >
                  Flash
                </button>
              </div>
            </div>

            <div className="setting">
              <span className="setting-label">
                LED strips
                <span className="setting-note">They stay lit after the host lets go, until changed.</span>
              </span>
              <div className="seg" data-enabled={open}>
                {[...state.externalLedColors, "off"].map((color) => (
                  <button
                    key={color}
                    className={state.externalLed === color ? "chooser chooser-on" : "chooser"}
                    disabled={!open}
                    onClick={() => guard(api.penta.externalLed(color))}
                  >
                    {name(color)}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting">
              <span className="setting-label">
                Flood
                <span className="setting-note">The white light the barcode engine reads by. Off stops decodes.</span>
              </span>
              <input
                type="range"
                className="flood"
                min={0}
                max={state.floodLevels}
                // Uncontrolled while dragging, and reset to what the scanner holds whenever that changes.
                key={state.floodLevel ?? "unread"}
                defaultValue={state.floodLevel ?? 0}
                disabled={!open || state.floodLevel === null}
                aria-label="flood level"
                // Committed on release, not while dragging: every step is a device write and a read-back.
                onPointerUp={(event) => guard(api.penta.flood(Number(event.currentTarget.value)))}
                onKeyUp={(event) => guard(api.penta.flood(Number(event.currentTarget.value)))}
              />
              <span className="stepper-value">{state.floodLevel === null ? "—" : state.floodLevel === 0 ? "Off" : `${state.floodLevel}/${state.floodLevels}`}</span>
            </div>

            <div className="setting">
              <span className="setting-label">Buzzer</span>
              <button className="alloff" disabled={!open} onClick={() => guard(api.penta.beep())}>Beep</button>
            </div>
          </div>
        </Card>
      </div>

      <div className="col col-narrow">
        <Card title="Device" aside={about ? undefined : "Not read"}>
          <div className="doorsim">
            <span className="doorsim-label">Identity</span>
            <button disabled={!open} onClick={() => api.penta.identity().then(setAbout).catch((err: Error) => onFail(err.message))}>
              Read
            </button>
          </div>
          {about && (
            <dl className="fields">
              <div className="field">
                <dt>Firmware</dt>
                <dd>{about.firmware || "—"}</dd>
              </div>
              <div className="field">
                <dt>Built</dt>
                <dd>{about.build || "—"}</dd>
              </div>
              <div className="field">
                <dt>Engine</dt>
                <dd>{about.engine || "—"}</dd>
              </div>
            </dl>
          )}
        </Card>
        {state.mock && (
          <Card title="Mock scanner" aside="No hardware">
            <div className="doorsim">
              <span className="doorsim-label">Glass</span>
              {SIMULATIONS.map(({ action, label }) => (
                <button key={action} disabled={!open} onClick={() => guard(api.penta.simulate(action))}>{label}</button>
              ))}
            </div>
          </Card>
        )}
        {aside}
      </div>
    </>
  );
}

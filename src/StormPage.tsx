import type { ReactNode } from "react";
import type { BaseState } from "./api.ts";
import * as api from "./api.ts";
import { LAMP, lampStyle } from "./look.ts";
import { Card } from "./ui.tsx";

export interface StormState extends BaseState {
  firmware: string | null;
  serial: string | null;
  keypadType: string | null;
  keyTable: string | null;
  led: number | null;
  jackLed: number | null;
  keypressBeep: boolean | null;
  /** Keys held right now, by name. */
  held: string[];
  /** The latest presses, newest first. */
  presses: { at: string; key: string }[];
  /** The headset jack's settled state; null until it first changes after connecting. */
  jack: boolean | null;
  /** The keypad's eight physical keys, from the driver. */
  keys: string[];
  maxLed: number;
}

const storm = api.device("storm");

/**
 * The Storm Nav-Pad's screen: the keys as they go down and up, captured exclusively so the OS sees
 * none of them, the headset jack, and the keypad's light and beeper as its status reports them.
 */
export function StormPage(
  { state, onFail, aside }: { state: StormState; onFail: (message: string) => void; aside: ReactNode },
) {
  const open = state.status === "open";
  const guard = (work: Promise<unknown>) => work.catch((err: Error) => onFail(err.message));
  const levels = Array.from({ length: state.maxLed + 1 }, (_, level) => level);

  const levelRow = (action: string, current: number | null) => (
    <div className="seg seg-wrap" data-enabled={open}>
      {levels.map((level) => (
        <button
          key={level}
          className={current === level ? "chooser chooser-on" : "chooser"}
          disabled={!open}
          onClick={() => guard(storm.act(action, { level }))}
        >
          {level === 0 ? "Off" : level}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div className="col col-wide">
        <Card title="Keys" aside="Captured" grow={3}>
          <div className="readpane">
            <div className="verdict" aria-live="polite">
              {!open
                ? "Connect the keypad to capture its keys."
                : state.held.length > 0
                ? `Holding ${state.held.join(" + ")}`
                : "Press a key on the keypad."}
            </div>
            <div className="seg seg-wrap" data-enabled={open} role="list" aria-label="key map">
              {state.keys.map((key) => {
                const down = state.held.includes(key);
                return (
                  <span key={key} role="listitem" className={down ? "chooser chooser-on" : "chooser"}>
                    <span className="chooser-lamp" style={lampStyle(LAMP.green, down ? "on" : "off", 12)} />
                    {key}
                  </span>
                );
              })}
            </div>
            <dl className="fields">
              <div className="field">
                <dt>Headset jack</dt>
                <dd>{state.jack === null ? "Not reported since connecting" : state.jack ? "Plugged in" : "Unplugged"}</dd>
              </div>
              {state.presses.map((press, index) => (
                <div className="field" key={`${press.at}-${index}`}>
                  <dt>{press.at}</dt>
                  <dd>{press.key}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Card>

        <Card title="Lights and sound" aside="Reported" grow={3}>
          <div className="settings">
            <div className="setting">
              <span className="setting-label">
                Light
                <span className="setting-note">On the bench Nav-Pad this lights the audio jack.</span>
              </span>
              {levelRow("led", state.led)}
            </div>
            <div className="setting">
              <span className="setting-label">
                Jack LED
                <span className="setting-note">Accepted, but no visible effect on the bench unit.</span>
              </span>
              {levelRow("jack-led", state.jackLed)}
            </div>
            <div className="setting">
              <span className="setting-label">Keypress beep</span>
              <div className="seg" data-enabled={open}>
                {[true, false].map((on) => (
                  <button
                    key={String(on)}
                    className={state.keypressBeep === on ? "chooser chooser-on" : "chooser"}
                    disabled={!open}
                    onClick={() => guard(storm.act("keypress-beep", { on }))}
                  >
                    {on ? "On" : "Off"}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting">
              <span className="setting-label">Beeper</span>
              <button className="alloff" disabled={!open} onClick={() => guard(storm.act("buzz", { quarters: 2 }))}>
                Buzz ½ s
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div className="col col-narrow">
        <Card title="Device" aside={state.serial ? undefined : "Not read"}>
          <div className="doorsim">
            <span className="doorsim-label">Status</span>
            <button disabled={!open} onClick={() => guard(storm.act("status"))}>Read</button>
          </div>
          <dl className="fields">
            <div className="field">
              <dt>USB</dt>
              <dd>{state.usbId}</dd>
            </div>
            <div className="field">
              <dt>Serial</dt>
              <dd>{state.serial || "—"}</dd>
            </div>
            <div className="field">
              <dt>Firmware</dt>
              <dd>{state.firmware || "—"}</dd>
            </div>
            <div className="field">
              <dt>Keypad</dt>
              <dd>{state.keypadType ?? "—"}</dd>
            </div>
            <div className="field">
              <dt>Key table</dt>
              <dd>{state.keyTable ?? "—"}</dd>
            </div>
          </dl>
        </Card>
        {state.mock && (
          <Card title="Mock keypad" aside="No hardware">
            <div className="doorsim">
              <span className="doorsim-label">Press</span>
              {state.keys.map((key) => (
                <button key={key} disabled={!open} onClick={() => guard(storm.act("simulate", { event: "press", key }))}>
                  {key}
                </button>
              ))}
            </div>
            <div className="doorsim">
              <span className="doorsim-label">Headset</span>
              {[true, false].map((inserted) => (
                <button
                  key={String(inserted)}
                  disabled={!open}
                  onClick={() => guard(storm.act("simulate", { event: "jack", inserted }))}
                >
                  {inserted ? "Plug in" : "Unplug"}
                </button>
              ))}
            </div>
          </Card>
        )}
        {aside}
      </div>
    </>
  );
}

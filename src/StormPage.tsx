import type { ReactNode } from "react";
import type { BaseState } from "./api.ts";
import * as api from "./api.ts";
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

/** Where each of the driver's keys sits on the face (row, column), and what is printed on it. */
const PLACE: Record<string, { row: number; col: number; legend: string }> = {
  home: { row: 1, col: 1, legend: "≪" },
  help: { row: 1, col: 2, legend: "?" },
  end: { row: 1, col: 3, legend: "≫" },
  back: { row: 2, col: 1, legend: "BACK" },
  next: { row: 2, col: 3, legend: "NEXT" },
  up: { row: 3, col: 2, legend: "" },
  down: { row: 4, col: 2, legend: "" },
  action: { row: 4, col: 3, legend: "" },
};

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
            <NavPad state={state} simulate={(body) => guard(storm.act("simulate", body))} />
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
            <p className="masknote">
              Click or tap a key on the drawn keypad to press it, and the jack to plug a headset in or out. Each goes through the real
              driver as a key report.
            </p>
          </Card>
        )}
        {aside}
      </div>
    </>
  );
}

/**
 * The keypad as it looks. A key lights while the keypad reports it held. With a mock keypad the keys
 * and the jack are buttons that press through the driver; with a real one the face is a display only.
 */
function NavPad({ state, simulate }: { state: StormState; simulate: (body: Record<string, unknown>) => void }) {
  const open = state.status === "open";
  const plugged = state.jack === true;
  const cell = (row: number, col: number) => ({ gridRow: row, gridColumn: col });
  const jackLabel = `Headset jack: ${state.jack === null ? "not reported" : plugged ? "plugged in" : "unplugged"}`;
  return (
    <div className="stormpad">
      <div className="stormpad-face" role="group" aria-label="Nav-Pad keys">
        {state.keys.filter((key) => PLACE[key]).map((key) => {
          const { row, col, legend } = PLACE[key];
          const down = state.held.includes(key);
          const props = { className: `stormkey stormkey-${key}`, "data-down": down, style: cell(row, col) };
          const cap = <span className="stormkey-cap" aria-hidden="true">{legend}</span>;
          return state.mock
            ? (
              <button key={key} {...props} disabled={!open} aria-label={`Press ${key}`} onClick={() => simulate({ event: "press", key })}>
                {cap}
              </button>
            )
            : <span key={key} {...props} role="img" aria-label={down ? `${key}, held` : key}>{cap}</span>;
        })}
        {state.mock
          ? (
            <button
              className="stormkey stormkey-jack"
              data-plugged={plugged}
              style={cell(4, 1)}
              disabled={!open}
              aria-label={`${jackLabel}. ${plugged ? "Unplug" : "Plug in"} the headset`}
              onClick={() => simulate({ event: "jack", inserted: !plugged })}
            >
              <span className="stormkey-cap" aria-hidden="true" />
            </button>
          )
          : (
            <span className="stormkey stormkey-jack" data-plugged={plugged} style={cell(4, 1)} role="img" aria-label={jackLabel}>
              <span className="stormkey-cap" />
            </span>
          )}
      </div>
    </div>
  );
}

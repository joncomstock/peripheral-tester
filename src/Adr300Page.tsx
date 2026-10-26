import { useState } from "react";
import type { ReactNode } from "react";
import type { BaseState } from "./api.ts";
import * as api from "./api.ts";
import { lampColor, lampStyle } from "./look.ts";
import { Card } from "./ui.tsx";

export interface Adr300State extends BaseState {
  /** As the reader reported it after the last change: its LED profile code, and the mode that means. */
  illumination: { profile: number; mode: string | null } | null;
  /** What was last commanded; the device does not report its LEDs. */
  led: { color: string; side: string } | null;
  /** The driver's own vocabularies. */
  illuminations: string[];
  ledColors: string[];
  ledSides: string[];
  sounds: string[];
}

/** The driver's names are code identifiers; spaced for reading. */
const words = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2");
const name = (value: string) => value[0].toUpperCase() + value.slice(1);
const hex = (value: number | null) => value === null ? "—" : `0x${value.toString(16).padStart(2, "0")}`;

/**
 * The Access-IS ADR300's screen: illumination, status LEDs and sounder, over the reader's HID
 * channel. The document image is a UVC camera the OS shows on its own; this channel reports no
 * document, MRZ or barcode, so there is nothing of the page's contents to show here.
 */
export function Adr300Page(
  { state, onFail, aside }: { state: Adr300State; onFail: (message: string) => void; aside: ReactNode },
) {
  const [side, setSide] = useState("both");
  const [about, setAbout] = useState<{ firmware: number; fpga: number | null; psoc: number } | null>(null);
  const open = state.status === "open";
  const act = (action: string, body?: unknown) => api.device("adr300").act(action, body).catch((err: Error) => onFail(err.message));

  return (
    <>
      <div className="col col-wide">
        <Card title="Illumination" aside={state.illumination ? `Profile ${hex(state.illumination.profile)}` : "Not read"} grow={3}>
          <div className="readpane">
            <div className="verdict">
              {!open
                ? "Connect the reader to drive its lights."
                : state.illumination?.mode
                ? `The reader reports ${words(state.illumination.mode).toLowerCase()}.`
                : "The reader reports a profile this driver does not map to a mode."}
            </div>
            <div className="seg seg-wrap" data-enabled={open}>
              {state.illuminations.map((mode) => (
                <button
                  key={mode}
                  className={state.illumination?.mode === mode ? "chooser chooser-on" : "chooser"}
                  disabled={!open}
                  onClick={() => act("illumination", { mode })}
                >
                  {words(mode)}
                </button>
              ))}
            </div>
          </div>
        </Card>

        <Card title="Status LEDs and sounder" aside="Commanded" grow={3}>
          <div className="settings">
            <div className="setting">
              <span className="setting-label">Side</span>
              <div className="seg" data-enabled={open}>
                {state.ledSides.map((value) => (
                  <button
                    key={value}
                    className={side === value ? "chooser chooser-on" : "chooser"}
                    disabled={!open}
                    onClick={() => setSide(value)}
                    aria-pressed={side === value}
                    title="Where the next colour lights"
                  >
                    {name(value)}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting">
              <span className="setting-label">Colour</span>
              <div className="seg seg-wrap" data-enabled={open}>
                {state.ledColors.map((color) => {
                  const lit = state.led?.color === color;
                  return (
                    <button
                      key={color}
                      className={lit ? "chooser chooser-on" : "chooser"}
                      disabled={!open}
                      onClick={() => act("led", { color, side })}
                    >
                      {color !== "all" && <span className="chooser-lamp" style={lampStyle(lampColor(color), lit ? "on" : "off", 12)} />}
                      {name(color)}
                    </button>
                  );
                })}
                <button
                  className={state.led === null ? "chooser chooser-on" : "chooser"}
                  disabled={!open}
                  onClick={() => act("led", { color: "off" })}
                >
                  Off
                </button>
              </div>
            </div>

            <div className="setting">
              <span className="setting-label">Sounder</span>
              <div className="seg seg-wrap" data-enabled={open}>
                {state.sounds.map((pattern) => (
                  <button key={pattern} className="chooser" disabled={!open} onClick={() => act("sound", { pattern })}>
                    {words(pattern)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div className="col col-narrow">
        <Card title="Device" aside={about ? undefined : "Not read"}>
          <div className="doorsim">
            <span className="doorsim-label">Versions</span>
            <button
              disabled={!open}
              onClick={() =>
                api.device("adr300").act<{ firmware: number; fpga: number | null; psoc: number }>("identity")
                  .then(({ firmware, fpga, psoc }) => setAbout({ firmware, fpga, psoc }))
                  .catch((err: Error) => onFail(err.message))}
            >
              Read
            </button>
          </div>
          {about && (
            <dl className="fields">
              <div className="field">
                <dt>Firmware</dt>
                <dd>{hex(about.firmware)}</dd>
              </div>
              <div className="field">
                <dt>FPGA</dt>
                <dd>{hex(about.fpga)}</dd>
              </div>
              <div className="field">
                <dt>PSoC</dt>
                <dd>{about.psoc}</dd>
              </div>
            </dl>
          )}
        </Card>
        {state.mock && (
          <Card title="Mock reader" aside="No hardware">
            <div className="doorsim">
              <span className="doorsim-label">Cable</span>
              <button disabled={!open} title="Noticed at the next command, as on a real reader" onClick={() => act("simulate", { event: "unplug" })}>
                Unplug
              </button>
            </div>
          </Card>
        )}
        {aside}
      </div>
    </>
  );
}

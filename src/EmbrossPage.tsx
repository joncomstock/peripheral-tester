import { useState } from "react";
import type { ReactNode } from "react";
import type { BaseState } from "./api.ts";
import * as api from "./api.ts";
import { LAMP, lampStyle } from "./look.ts";
import { Card } from "./ui.tsx";

export interface EmbrossState extends BaseState {
  /** The serial port whose handshake lines carry the switches; chosen while closed. */
  port: string;
  defaultPort: string;
  pollIntervalMs: number;
  /** Null while not connected: the switches are only read while the port is held. */
  doorOpen: boolean | null;
  buttonPressed: boolean | null;
  /** Newest first, with the server's clock. */
  transitions: { at: string; text: string }[];
}

const embross = api.device("embross");

/**
 * The Embross V1's service button and door switch: what each reads now, and every change seen.
 * Both are inputs, so there is nothing to command; the port they are read from is the one setting.
 */
export function EmbrossPage(
  { state, onFail, aside }: { state: EmbrossState; onFail: (message: string) => void; aside: ReactNode },
) {
  const [port, setPort] = useState(state.port);
  const open = state.status === "open";
  const closed = state.status === "closed";
  const guard = (work: Promise<unknown>) => work.catch((err: Error) => onFail(err.message));
  const simulate = (which: "door" | "button", on: boolean) => guard(embross.act("simulate", { switch: which, on }));

  const rows = [
    {
      label: "Service button",
      lit: state.buttonPressed === true,
      word: state.buttonPressed === null ? "—" : state.buttonPressed ? "Pressed" : "Up",
    },
    {
      label: "Door",
      lit: state.doorOpen === true,
      word: state.doorOpen === null ? "—" : state.doorOpen ? "Open" : "Shut",
    },
  ];

  return (
    <>
      <div className="col col-wide">
        <Card title="Switches" aside="Reported">
          {rows.map(({ label, lit, word }) => (
            <div className="doorrow" key={label}>
              <span style={lampStyle(LAMP.amber, lit ? "on" : "off", 16)} />
              <span className="doorlabel">{label}</span>
              <span className={lit ? "doorstate doorstate-open" : "doorstate"}>{word}</span>
            </div>
          ))}
          {!open && <div className="verdict">Connect to read the switches.</div>}
        </Card>

        <Card title="Transitions" aside={`Sampled every ${state.pollIntervalMs} ms`} grow={3}>
          <div className="readpane">
            {state.transitions.length === 0
              ? (
                <div className="verdict">
                  {open ? "No change since connecting. Press the service button or open the door." : "Nothing seen yet."}
                </div>
              )
              : (
                <dl className="fields">
                  {state.transitions.map(({ at, text }, i) => (
                    <div className="field" key={`${at}-${i}`}>
                      <dt>{at}</dt>
                      <dd>{text}</dd>
                    </div>
                  ))}
                </dl>
              )}
          </div>
        </Card>
      </div>

      <div className="col col-narrow">
        <Card title="Device" aside="RS-232">
          <div className="settings">
            <div className="setting">
              <label className="setting-label" htmlFor="embross-port">
                Port
                <span className="setting-note">Read from the handshake lines; no bytes are sent. Default {state.defaultPort}.</span>
              </label>
              <input
                id="embross-port"
                value={port}
                disabled={!closed}
                onChange={(event) => setPort(event.currentTarget.value)}
              />
              <button
                className="alloff"
                disabled={!closed || port.trim() === state.port}
                onClick={() => guard(embross.act("port", { port }))}
              >
                Use
              </button>
            </div>
          </div>
        </Card>
        {state.mock && (
          <Card title="Mock switches" aside="No hardware">
            <div className="doorsim">
              <span className="doorsim-label">Button</span>
              <button disabled={!open || state.buttonPressed === true} onClick={() => simulate("button", true)}>Press</button>
              <button disabled={!open || state.buttonPressed === false} onClick={() => simulate("button", false)}>Release</button>
            </div>
            <div className="doorsim">
              <span className="doorsim-label">Door</span>
              <button disabled={!open || state.doorOpen === true} onClick={() => simulate("door", true)}>Open</button>
              <button disabled={!open || state.doorOpen === false} onClick={() => simulate("door", false)}>Shut</button>
            </div>
          </Card>
        )}
        {aside}
      </div>
    </>
  );
}

import { useState } from "react";
import type { ReactNode } from "react";
import type { BaseState } from "./api.ts";
import * as api from "./api.ts";
import { Card } from "./ui.tsx";

export interface DatalogicState extends BaseState {
  reading: "presentation" | "single" | null;
  barcode: { symbology: string | null; text: string } | null;
  /** The symbologies last commanded; null until set since connecting. */
  enabled: string[] | null;
  presentationMode: string;
  symbologies: string[];
  presentationModes: string[];
  /** The mock's simulated events, with their button labels. */
  simulations: { code: string; label: string }[];
}

const scanner = api.device("datalogic");
/** `OBJECT_SENSE` → `Object sense`. */
const name = (mode: string) => mode[0] + mode.slice(1).toLowerCase().replace("_", " ");

/**
 * The Datalogic Gryphon's screen: the last code it decoded, presentation reading and single reads,
 * and the symbologies and presentation mode it reads with. Settings change only while it is not
 * reading, since a command's reply would be lost to the read loop.
 */
export function DatalogicPage(
  { state, onFail, aside }: { state: DatalogicState; onFail: (message: string) => void; aside: ReactNode },
) {
  const [firmware, setFirmware] = useState<string | null>(null);
  const open = state.status === "open";
  const idle = open && state.reading === null;
  const guard = (work: Promise<unknown>) => work.catch((err: Error) => onFail(err.message));
  const toggle = (code: string) => {
    const now = state.enabled ?? state.symbologies;
    guard(scanner.act("symbologies", { codes: now.includes(code) ? now.filter((c) => c !== code) : [...now, code] }));
  };

  return (
    <>
      <div className="col col-wide">
        <Card title="Last read" aside="Reported" grow={3}>
          <div className="readpane">
            <div className="verdict">
              {!open
                ? "Connect the scanner to read barcodes."
                : state.reading === "presentation"
                ? "Listening: present a code to the scanner."
                : state.reading === "single"
                ? "Single read: present a code before it times out."
                : state.barcode
                ? "Idle. The last code read is below."
                : "Idle. Listen or Trigger to read."}
            </div>
            {state.barcode && (
              <dl className="fields">
                <div className="field">
                  <dt>Symbology</dt>
                  <dd>{state.barcode.symbology ?? "Not sent"}</dd>
                </div>
                <div className="field">
                  <dt>Barcode</dt>
                  <dd className="barcode-text">{state.barcode.text}</dd>
                </div>
              </dl>
            )}
          </div>
        </Card>

        <Card title="Reading" aside={state.enabled ? "Commanded" : "Scanner's own until set"} grow={3}>
          <div className="settings">
            <div className="setting">
              <span className="setting-label">
                Presentation
                <span className="setting-note">Reads every code shown until stopped.</span>
              </span>
              <div className="seg" data-enabled={open}>
                <button
                  className={state.reading === "presentation" ? "chooser chooser-on" : "chooser"}
                  disabled={!idle}
                  onClick={() => guard(scanner.act("listen"))}
                >
                  Listen
                </button>
                <button className="chooser" disabled={!open || state.reading === null} onClick={() => guard(scanner.act("stop"))}>
                  Stop
                </button>
              </div>
            </div>

            <div className="setting">
              <span className="setting-label">
                Single read
                <span className="setting-note">Like a trigger pull: ends at the first decode or after 5 s.</span>
              </span>
              <button className="alloff" disabled={!idle} onClick={() => guard(scanner.act("trigger", { seconds: 5 }))}>
                Trigger
              </button>
            </div>

            <div className="setting">
              <span className="setting-label">
                Presentation mode
                <span className="setting-note">Object sense ignores a code left in view; automatic reads it again.</span>
              </span>
              <div className="seg" data-enabled={idle}>
                {state.presentationModes.map((mode) => (
                  <button
                    key={mode}
                    className={state.presentationMode === mode ? "chooser chooser-on" : "chooser"}
                    disabled={!idle}
                    onClick={() => guard(scanner.act("presentation", { mode }))}
                  >
                    {name(mode)}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting">
              <span className="setting-label">
                Symbologies
                <span className="setting-note">Lost when the scanner restarts.</span>
              </span>
              <div className="seg seg-wrap" data-enabled={idle}>
                {state.symbologies.map((code) => (
                  <button
                    key={code}
                    className={state.enabled?.includes(code) ? "chooser chooser-on" : "chooser"}
                    disabled={!idle}
                    onClick={() => toggle(code)}
                  >
                    {code}
                  </button>
                ))}
                <button className="chooser" disabled={!idle} onClick={() => guard(scanner.act("symbologies", { codes: state.symbologies }))}>
                  All
                </button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div className="col col-narrow">
        <Card title="Device" aside={firmware ? undefined : "Not read"}>
          <div className="doorsim">
            <span className="doorsim-label">Identity</span>
            <button
              disabled={!idle}
              onClick={() =>
                scanner.act<{ firmware: string }>("identity").then((reply) => setFirmware(reply.firmware)).catch((err: Error) =>
                  onFail(err.message)
                )}
            >
              Read
            </button>
          </div>
          {firmware && (
            <dl className="fields">
              <div className="field">
                <dt>Firmware</dt>
                <dd>{firmware}</dd>
              </div>
            </dl>
          )}
        </Card>
        {state.mock && (
          <Card title="Mock scanner" aside="No hardware">
            <div className="doorsim">
              <span className="doorsim-label">Show</span>
              {state.simulations.map(({ code, label }) => (
                <button key={code} disabled={!open} onClick={() => guard(scanner.act("simulate", { code }))}>{label}</button>
              ))}
            </div>
          </Card>
        )}
        {aside}
      </div>
    </>
  );
}

import { useState } from "react";
import type { ReactNode } from "react";
import type { BaseState } from "./api.ts";
import * as api from "./api.ts";
import { Card } from "./ui.tsx";

/** Mirrors the driver's `ITK38Status`; the flag names come from it through state. */
export interface Itk38State extends BaseState {
  printer: {
    flags: Record<string, boolean>;
    errorCode: number;
    documentCount: number;
    temperature: number;
    formLength: number;
    firmwareVersion: string;
  } | null;
  simulations: string[];
}

/** "outOfPaper" -> "Out of paper": the driver's flag names, worded for the operator. */
const words = (flag: string) => {
  const spaced = flag.replace(/([A-Z])/g, " $1").toLowerCase();
  return spaced[0].toUpperCase() + spaced.slice(1);
};

/**
 * The ITK 38's screen: paper and document state as the printer streams it, a test boarding pass, and
 * the presented document's eject and dispose.
 */
export function Itk38Page(
  { state, onFail, aside }: { state: Itk38State; onFail: (message: string) => void; aside: ReactNode },
) {
  const [about, setAbout] = useState<{ serial: string; firmware: string } | null>(null);
  const open = state.status === "open";
  const act = (action: string, body?: unknown) => api.device("itk38").act(action, body).catch((err: Error) => onFail(err.message));
  const p = state.printer;
  const f = p?.flags ?? {};
  const raised = Object.keys(f).filter((flag) => f[flag]);
  const paper = f.outOfPaper ? "Out of paper." : f.paperError ? "Paper error: jammed or misfed." : f.lowPaper ? "Paper is low." : "Paper loaded.";
  const documentText = f.documentInProgress
    ? "Printing."
    : f.documentNotTaken
    ? "A printed document is waiting to be taken."
    : f.documentDisposed
    ? "The last document was disposed."
    : "No document presented.";

  return (
    <>
      <div className="col col-wide">
        <Card title="Printer status" aside="Reported" grow={3}>
          <div className="readpane">
            <div className="verdict">
              {!open || !p ? "Connect the printer to see its paper and status." : `${paper} ${documentText}${f.headLeverUp ? " The print head is open." : ""}`}
            </div>
            {open && p && (
              <dl className="fields">
                <div className="field">
                  <dt>Flags raised</dt>
                  <dd>{raised.length ? raised.map(words).join(", ") : "None"}</dd>
                </div>
                <div className="field">
                  <dt>Error code</dt>
                  <dd>{p.errorCode}</dd>
                </div>
                <div className="field">
                  <dt>Documents since power-on</dt>
                  <dd>{p.documentCount}</dd>
                </div>
                <div className="field">
                  <dt>Head temperature</dt>
                  <dd>{p.temperature} °C</dd>
                </div>
                <div className="field">
                  <dt>Form length</dt>
                  <dd>{p.formLength === 0 ? "Roll" : `${(p.formLength / 100).toFixed(2)} in`}</dd>
                </div>
              </dl>
            )}
          </div>
        </Card>

        <Card title="Print" aside="Commanded" grow={2}>
          <div className="settings">
            <div className="setting">
              <span className="setting-label">
                Test boarding pass
                <span className="setting-note">A fixed 8 x 3.25 in sample marked not valid for travel. Refused while out of paper, jammed or open.</span>
              </span>
              <button className="alloff" disabled={!open} onClick={() => act("print")}>Print</button>
            </div>
            <div className="setting">
              <span className="setting-label">
                Presented document
                <span className="setting-note">Re-present it at the slot, or drop it into the bin.</span>
              </span>
              <div className="seg" data-enabled={open}>
                <button className="chooser" disabled={!open} onClick={() => act("eject")}>Eject</button>
                <button className="chooser" disabled={!open} onClick={() => act("dispose")}>Dispose</button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div className="col col-narrow">
        <Card title="Device" aside={about ? undefined : "Not read"}>
          <div className="doorsim">
            <span className="doorsim-label">Identity</span>
            <button
              disabled={!open}
              onClick={() =>
                api.device("itk38").act<{ serial: string; firmware: string }>("identity").then(setAbout).catch((err: Error) =>
                  onFail(err.message)
                )}
            >
              Read
            </button>
          </div>
          {(about || p) && (
            <dl className="fields">
              <div className="field">
                <dt>Serial</dt>
                <dd>{about?.serial || "—"}</dd>
              </div>
              <div className="field">
                <dt>Firmware</dt>
                <dd>{p?.firmwareVersion || about?.firmware || "—"}</dd>
              </div>
            </dl>
          )}
        </Card>
        {state.mock && (
          <Card title="Mock printer" aside="No hardware">
            <div className="seg seg-wrap" data-enabled={open}>
              {state.simulations.map((event) => (
                <button key={event} disabled={!open} onClick={() => act("simulate", { event })}>
                  {words(event.replace("-", " "))}
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

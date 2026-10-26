import type { ReactNode } from "react";
import type { BaseState } from "./api.ts";
import * as api from "./api.ts";
import { Card } from "./ui.tsx";

export interface K8State extends BaseState {
  identity: { serialNumber: string; model: string; firmware: string; firmwareDate: string; twoSided: boolean } | null;
  config: { density: number; documentLength: number; blackMark: boolean; paperWidth: string } | null;
  /** The last status read: faults that stop a page, every bit set, and the six bytes. */
  paper: { faults: string[]; set: string[]; raw: string } | null;
}

const SIMULATIONS: { action: string; label: string }[] = [
  { action: "paper-low", label: "Paper low" },
  { action: "paper-out", label: "Paper out" },
  { action: "jam", label: "Jam" },
  { action: "clear", label: "Clear" },
  { action: "unplug", label: "Unplug" },
];

/**
 * The NCR K8's screen: the printer's status as last read, a test page, and its identity. The status
 * is read when asked and after every command; the printer never reports on its own.
 */
export function K8Page({ state, onFail, aside }: { state: K8State; onFail: (message: string) => void; aside: ReactNode }) {
  const open = state.status === "open";
  const k8 = api.device("k8");
  const guard = (work: Promise<unknown>) => work.catch((err: Error) => onFail(err.message));
  const paper = state.paper;

  return (
    <>
      <div className="col col-wide">
        <Card title="Printer status" aside="Read" grow={3}>
          <div className="readpane">
            <div className="verdict">
              {!open
                ? "Connect the printer to read its status."
                : !paper
                ? "Not read yet."
                : paper.faults.length
                ? `Will not print: ${paper.faults.join(", ")}.`
                : paper.set.includes("paperLow")
                ? "Ready, but the paper is low."
                : "Ready."}
            </div>
            {paper && (
              <dl className="fields">
                <div className="field">
                  <dt>Bits set</dt>
                  <dd>{paper.set.join(", ") || "—"}</dd>
                </div>
                <div className="field">
                  <dt>Raw</dt>
                  <dd className="barcode-text">{paper.raw}</dd>
                </div>
              </dl>
            )}
          </div>
        </Card>

        <Card title="Printing" aside="Commanded" grow={2}>
          <div className="settings">
            <div className="setting">
              <span className="setting-label">Status</span>
              <button className="alloff" disabled={!open} onClick={() => guard(k8.act("status"))}>Read</button>
            </div>
            <div className="setting">
              <span className="setting-label">
                Test page
                <span className="setting-note">A 70 mm page of boxes and squares, cut at the end.</span>
              </span>
              <button className="alloff" disabled={!open} onClick={() => guard(k8.act("print-test"))}>Print</button>
            </div>
            <div className="setting">
              <span className="setting-label">
                Recover
                <span className="setting-note">Clears the buffers and leaves an error state once its cause is gone.</span>
              </span>
              <button className="alloff" disabled={!open} onClick={() => guard(k8.act("recover"))}>Recover</button>
            </div>
          </div>
        </Card>
      </div>

      <div className="col col-narrow">
        <Card title="Device" aside={state.identity ? undefined : "Not read"}>
          {state.identity && (
            <dl className="fields">
              <div className="field">
                <dt>Model</dt>
                <dd>{state.identity.model}</dd>
              </div>
              <div className="field">
                <dt>Serial</dt>
                <dd>{state.identity.serialNumber}</dd>
              </div>
              <div className="field">
                <dt>Firmware</dt>
                <dd>{`${state.identity.firmware} (${state.identity.firmwareDate})`}</dd>
              </div>
              <div className="field">
                <dt>Two-sided</dt>
                <dd>{state.identity.twoSided ? "Yes" : "No"}</dd>
              </div>
            </dl>
          )}
          {state.config && (
            <dl className="fields">
              <div className="field">
                <dt>Paper width</dt>
                <dd>{state.config.paperWidth}</dd>
              </div>
              <div className="field">
                <dt>Cut</dt>
                <dd>{state.config.blackMark ? "At black marks" : `Every ${state.config.documentLength} dots`}</dd>
              </div>
              <div className="field">
                <dt>Density</dt>
                <dd>{state.config.density}</dd>
              </div>
            </dl>
          )}
        </Card>
        {state.mock && (
          <Card title="Mock printer" aside="No hardware">
            <div className="doorsim">
              <span className="doorsim-label">Paper</span>
              {SIMULATIONS.map(({ action, label }) => (
                <button key={action} disabled={!open} onClick={() => guard(k8.act("simulate", { action }))}>{label}</button>
              ))}
            </div>
          </Card>
        )}
        {aside}
      </div>
    </>
  );
}

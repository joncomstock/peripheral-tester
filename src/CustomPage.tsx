import { useState } from "react";
import type { ReactNode } from "react";
import type { BaseState } from "./api.ts";
import * as api from "./api.ts";
import { Card } from "./ui.tsx";

export interface CustomState extends BaseState {
  /** Printing or identifying; other commands are refused meanwhile. */
  busy: boolean;
  paper: {
    paperOut: boolean;
    paperLow: boolean;
    paperJam: boolean;
    coverOpen: boolean;
    ticketAtExit: boolean;
    /** The driver's words for whatever stops a ticket printing. */
    faults: string[];
  } | null;
}

interface Identity {
  model: string;
  firmware: string;
  serialNumber: string;
  autocutter: boolean;
  labelStock: boolean;
  firmwareLines: string[];
}

const SIMULATIONS = [
  { condition: "paper-low", label: "Paper low" },
  { condition: "paper-out", label: "Paper out" },
  { condition: "jam", label: "Jam" },
  { condition: "clear", label: "All clear" },
];

const printer = api.device("custom");
const yes = (on: boolean) => on ? "Yes" : "No";

/**
 * The CUSTOM KPM printer's screen: its paper and fault status, a fixed test ticket, and the unit's
 * identity. CUSTOM/POS reports nothing on its own, so the status is as of the last read.
 */
export function CustomPage(
  { state, onFail, aside }: { state: CustomState; onFail: (message: string) => void; aside: ReactNode },
) {
  const [about, setAbout] = useState<Identity | null>(null);
  const open = state.status === "open";
  const ready = open && !state.busy;
  const guard = (work: Promise<unknown>) => work.catch((err: Error) => onFail(err.message));
  const paper = state.paper;

  return (
    <>
      <div className="col col-wide">
        <Card title="Status" aside="As last read" grow={3}>
          <div className="readpane">
            <div className="verdict">
              {!open
                ? "Connect the printer to read its status."
                : state.busy
                ? "Working…"
                : !paper
                ? "Not read yet."
                : paper.faults.length
                ? `Cannot print: ${paper.faults.join(", ")}.`
                : paper.paperLow
                ? "Ready, but the paper is low."
                : "Ready to print."}
            </div>
            {paper && (
              <dl className="fields">
                <div className="field">
                  <dt>Paper</dt>
                  <dd>{paper.paperOut ? "Out" : paper.paperLow ? "Low" : "OK"}</dd>
                </div>
                <div className="field">
                  <dt>Jam</dt>
                  <dd>{yes(paper.paperJam)}</dd>
                </div>
                <div className="field">
                  <dt>Cover open</dt>
                  <dd>{yes(paper.coverOpen)}</dd>
                </div>
                <div className="field">
                  <dt>Ticket at exit</dt>
                  <dd>{yes(paper.ticketAtExit)}</dd>
                </div>
              </dl>
            )}
          </div>
        </Card>

        <Card title="Printing" grow={3}>
          <div className="settings">
            <div className="setting">
              <span className="setting-label">Status</span>
              <button className="alloff" disabled={!ready} onClick={() => guard(printer.act("status"))}>Read</button>
            </div>
            <div className="setting">
              <span className="setting-label">
                Test ticket
                <span className="setting-note">A framed "TEST TICKET / NOT VALID", 48 mm wide, then a cut.</span>
              </span>
              <button className="alloff" disabled={!ready} onClick={() => guard(printer.act("print"))}>Print</button>
            </div>
          </div>
        </Card>
      </div>

      <div className="col col-narrow">
        <Card title="Device" aside={about ? undefined : "Not read"}>
          <div className="doorsim">
            <span className="doorsim-label">Identity</span>
            <button disabled={!ready} onClick={() => printer.act<Identity>("identity").then(setAbout).catch((err: Error) => onFail(err.message))}>
              Read
            </button>
          </div>
          {about && (
            <dl className="fields">
              <div className="field">
                <dt>Model</dt>
                <dd>{about.model}</dd>
              </div>
              <div className="field">
                <dt>Firmware</dt>
                <dd>{about.firmware}</dd>
              </div>
              <div className="field">
                <dt>Serial</dt>
                <dd>{about.serialNumber || "—"}</dd>
              </div>
              <div className="field">
                <dt>Cutter / label stock</dt>
                <dd>{yes(about.autocutter)} / {yes(about.labelStock)}</dd>
              </div>
              {about.firmwareLines.map((line, i) => (
                <div className="field" key={i}>
                  <dt>{i === 0 ? "Firmware info" : ""}</dt>
                  <dd>{line}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
        {state.mock && (
          <Card title="Mock printer" aside="No hardware">
            <div className="doorsim">
              <span className="doorsim-label">Paper</span>
              {SIMULATIONS.map(({ condition, label }) => (
                <button key={condition} disabled={!ready} onClick={() => guard(printer.act("simulate", { condition }))}>{label}</button>
              ))}
            </div>
          </Card>
        )}
        {aside}
      </div>
    </>
  );
}

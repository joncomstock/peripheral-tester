import { useState } from "react";
import type { ReactNode } from "react";
import type { BaseState } from "./api.ts";
import * as api from "./api.ts";
import { Card } from "./ui.tsx";

export interface XpmState extends BaseState {
  /** A test print is out and its completion not yet reported. */
  printing: boolean;
  /** The last status the printer answered, polled every couple of seconds. Null until connected. */
  printer: {
    paper: "ok" | "low" | "out";
    /** The driver's status flag names that are set. */
    flags: string[];
    /** The driver's decoding of the error code, or null when there is none. */
    error: { type: string; context: string } | null;
    temperature: number;
    voltage: number;
  } | null;
  /** What the mock printer is set to report. Null on real hardware. */
  simulated: { paper: "ok" | "low" | "out"; jammed: boolean; chute: boolean } | null;
}

type Simulation = "paper-ok" | "paper-low" | "paper-out" | "jam" | "clear-jam" | "take";

const PAPER_TEXT = { ok: "Loaded", low: "Low", out: "Out" } as const;

interface Identity {
  model: string;
  partNumber: string;
  serialNumber: string;
  firmwareVersion: string;
  firmwareDate: string;
}

/**
 * The XPM boarding-pass printer's screen: what the printer last reported (paper, faults, the chute),
 * and a test print of a fabricated sample. The printer never sends status unasked, so the backend
 * polls it; what shows here is at most a couple of seconds old.
 */
export function XpmPage({ state, onFail, aside }: { state: XpmState; onFail: (message: string) => void; aside: ReactNode }) {
  const [about, setAbout] = useState<Identity | null>(null);
  const open = state.status === "open";
  const xpm = api.device("xpm");
  const guard = (work: Promise<unknown>) => work.catch((err: Error) => onFail(err.message));
  const simulate = (action: Simulation) => guard(xpm.act("simulate", { action }));
  const p = state.printer;
  const chute = p?.flags.includes("paperInChute") ?? false;
  const bad = !!p && (p.error !== null || p.paper === "out" || p.flags.includes("printheadRaised"));

  const verdict = !open || !p
    ? "Connect the printer to see its status."
    : p.error
    ? `${p.error.type} — ${p.error.context.toLowerCase()}. Clear it before printing.`
    : p.paper === "out"
    ? "Out of paper. Load a roll before printing."
    : p.flags.includes("printheadRaised")
    ? "The printhead is raised. Close it before printing."
    : chute
    ? "A pass is waiting in the chute."
    : p.paper === "low"
    ? "Ready, but paper is low."
    : "Ready.";

  return (
    <>
      <div className="col col-wide">
        <Card title="Printer status" aside="Polled" grow={3}>
          <div className="readpane">
            <div className={bad ? "verdict verdict-bad" : "verdict"}>{verdict}</div>
            {open && p && (
              <dl className="fields">
                <div className="field">
                  <dt>Paper</dt>
                  <dd>{PAPER_TEXT[p.paper]}</dd>
                </div>
                <div className="field">
                  <dt>Error</dt>
                  <dd>{p.error ? `${p.error.type} (${p.error.context})` : "None"}</dd>
                </div>
                <div className="field">
                  <dt>Printhead</dt>
                  <dd>{p.temperature} °C</dd>
                </div>
                <div className="field">
                  <dt>Supply</dt>
                  <dd>{p.voltage.toFixed(1)} V</dd>
                </div>
                <div className="field">
                  <dt>Flags set</dt>
                  <dd>{p.flags.length ? p.flags.join(", ") : "None"}</dd>
                </div>
              </dl>
            )}
          </div>
        </Card>

        <Card title="Test print" aside={state.printing ? "Printing" : undefined} grow={2}>
          <div className="readpane">
            <div className="readpane-actions">
              <button className="primary" disabled={!open || state.printing} onClick={() => guard(xpm.act("print-test"))}>
                {state.printing ? "Printing…" : "Print test pass"}
              </button>
            </div>
            <span className="setting-note">
              Prints and cuts a fabricated sample marked NOT A BOARDING PASS, with the time it was printed. It finishes when the printer
              reports the cut.
            </span>
          </div>
        </Card>
      </div>

      <div className="col col-narrow">
        <Card title="Device" aside={about ? undefined : "Not read"}>
          <div className="doorsim">
            <span className="doorsim-label">Identity</span>
            <button disabled={!open} onClick={() => xpm.act<Identity>("identity").then(setAbout).catch((err: Error) => onFail(err.message))}>
              Read
            </button>
          </div>
          {about && (
            <dl className="fields">
              <div className="field">
                <dt>Model</dt>
                <dd>{about.model || "—"}</dd>
              </div>
              <div className="field">
                <dt>Part</dt>
                <dd>{about.partNumber || "—"}</dd>
              </div>
              <div className="field">
                <dt>Serial</dt>
                <dd>{about.serialNumber || "—"}</dd>
              </div>
              <div className="field">
                <dt>Firmware</dt>
                <dd>{[about.firmwareVersion, about.firmwareDate].filter(Boolean).join(" · ") || "—"}</dd>
              </div>
            </dl>
          )}
        </Card>
        {state.mock && (
          <Card title="Mock printer" aside="No hardware">
            <div className="doorsim">
              <span className="doorsim-label">Paper</span>
              {(["ok", "low", "out"] as const).map((paper) => (
                <button
                  key={paper}
                  className={state.simulated?.paper === paper ? "chooser chooser-on" : "chooser"}
                  disabled={!open}
                  onClick={() => simulate(`paper-${paper}`)}
                >
                  {PAPER_TEXT[paper]}
                </button>
              ))}
            </div>
            <div className="doorsim">
              <span className="doorsim-label">Faults</span>
              <button disabled={!open} onClick={() => simulate(state.simulated?.jammed ? "clear-jam" : "jam")}>
                {state.simulated?.jammed ? "Clear jam" : "Jam"}
              </button>
              <button disabled={!open || !state.simulated?.chute} onClick={() => simulate("take")}>Take pass</button>
            </div>
          </Card>
        )}
        {aside}
      </div>
    </>
  );
}

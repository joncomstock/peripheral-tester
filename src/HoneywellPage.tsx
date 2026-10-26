import { useState } from "react";
import type { ReactNode } from "react";
import type { BaseState } from "./api.ts";
import * as api from "./api.ts";
import { Card } from "./ui.tsx";

export interface HoneywellState extends BaseState {
  mode: "idle" | "listening" | "single";
  barcode: { symbology: string | null; text: string } | null;
  beeper: { on: boolean; volume: number } | null;
  /** BEPLVL's labels, by value. */
  beeperVolumes: string[];
}

type Field = { label: string; value: string };

const MODE_TEXT: Record<HoneywellState["mode"], string> = {
  idle: "Not reading. Listen to read every code presented, or trigger a single read.",
  listening: "Reading every code presented to the window.",
  single: "Waiting for one code…",
};

const SINGLE_SECONDS = 10;

/**
 * The Honeywell 5X80's screen: the last code it decoded, presentation and single reads, the beeper,
 * and what the scanner says it is. Every setting, the reading mode included, applies until power-off
 * and none is saved; the kiosk's prefixes and suffixes are put back on disconnect.
 */
export function HoneywellPage(
  { state, onFail, aside }: { state: HoneywellState; onFail: (message: string) => void; aside: ReactNode },
) {
  const [about, setAbout] = useState<Field[] | null>(null);
  const scanner = api.device("honeywell");
  const open = state.status === "open";
  const idle = open && state.mode === "idle";
  const guard = (work: Promise<unknown>) => work.catch((err: Error) => onFail(err.message));

  return (
    <>
      <div className="col col-wide">
        <Card title="Last barcode" aside="Decoded" grow={3}>
          <div className="readpane">
            <div className="verdict">{open ? MODE_TEXT[state.mode] : "Connect the scanner to read barcodes."}</div>
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

        <Card title="Scanning and beeper" aside="Until power-off" grow={3}>
          <div className="settings">
            <div className="setting">
              <span className="setting-label">
                Reading
                <span className="setting-note">While it reads, the scanner takes every reply: stop it to change a setting.</span>
              </span>
              <div className="seg" data-enabled={open}>
                <button
                  className={state.mode === "listening" ? "chooser chooser-on" : "chooser"}
                  disabled={!idle}
                  onClick={() => guard(scanner.act("listen"))}
                >
                  Listen
                </button>
                <button
                  className={state.mode === "single" ? "chooser chooser-on" : "chooser"}
                  disabled={!idle}
                  onClick={() => guard(scanner.act("single-read", { seconds: SINGLE_SECONDS }))}
                >
                  Single read ({SINGLE_SECONDS} s)
                </button>
                <button
                  className={state.mode === "idle" ? "chooser chooser-on" : "chooser"}
                  disabled={!open || state.mode === "idle"}
                  onClick={() => guard(scanner.act("stop"))}
                >
                  Stop
                </button>
              </div>
            </div>

            <div className="setting">
              <span className="setting-label">Beep on a good read</span>
              <div className="seg" data-enabled={idle}>
                {[true, false].map((on) => (
                  <button
                    key={String(on)}
                    className={state.beeper?.on === on ? "chooser chooser-on" : "chooser"}
                    disabled={!idle}
                    onClick={() => guard(scanner.act("beeper", { on }))}
                  >
                    {on ? "On" : "Off"}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting">
              <span className="setting-label">Beep volume</span>
              <div className="seg" data-enabled={idle}>
                {state.beeperVolumes.map((label, volume) => (
                  <button
                    key={label}
                    className={state.beeper?.volume === volume ? "chooser chooser-on" : "chooser"}
                    disabled={!idle}
                    onClick={() => guard(scanner.act("beeper", { volume }))}
                  >
                    {label}
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
            <span className="doorsim-label">Identity</span>
            <button
              disabled={!idle}
              onClick={() =>
                scanner.act<{ identity: Field[] }>("identity").then((reply) => setAbout(reply.identity)).catch((err: Error) =>
                  onFail(err.message)
                )}
            >
              Read
            </button>
          </div>
          {about && (
            <dl className="fields">
              {about.map(({ label, value }, at) => (
                // REVINF can repeat a label (the engine's own revision, serial).
                <div className="field" key={at}>
                  <dt>{label}</dt>
                  <dd>{value || "—"}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
        {state.mock && (
          <Card title="Mock scanner" aside="No hardware">
            <div className="doorsim">
              <span className="doorsim-label">Present</span>
              <button disabled={!open} onClick={() => guard(scanner.act("simulate", { code: "boarding-pass" }))}>
                Boarding pass
              </button>
              <button disabled={!open} onClick={() => guard(scanner.act("simulate", { code: "qr" }))}>QR code</button>
            </div>
            <div className="doorsim">
              <span className="doorsim-label">Cable</span>
              <button disabled={!open} onClick={() => guard(scanner.act("simulate", { code: "unplug" }))}>Unplug</button>
            </div>
          </Card>
        )}
        {aside}
      </div>
    </>
  );
}

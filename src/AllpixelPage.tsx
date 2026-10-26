import type { ReactNode } from "react";
import type { BaseState } from "./api.ts";
import * as api from "./api.ts";
import { lampColor, lampStyle } from "./look.ts";
import { Card } from "./ui.tsx";

export interface AllpixelState extends BaseState {
  boardId: number | null;
  ledCount: number;
  colors: string[];
  zones: string[];
  /** Each zone's commanded colour: a colour's name, "off", or "mixed". */
  lit: Record<string, string>;
}

/** "passportReader" → "Passport reader". */
const words = (name: string) => {
  const spaced = name.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
  return spaced[0].toUpperCase() + spaced.slice(1);
};

/**
 * The AllPixel's screen: each zone of the Embross V1 string set to a colour or off. The lamps show
 * what was commanded; the board does not report its LEDs.
 */
export function AllpixelPage(
  { state, onFail, aside }: { state: AllpixelState; onFail: (message: string) => void; aside: ReactNode },
) {
  const open = state.status === "open";
  const allpixel = api.device("allpixel");
  const guard = (work: Promise<unknown>) => work.catch((err: Error) => onFail(err.message));

  return (
    <>
      <div className="col col-wide">
        <Card title="LED zones" aside="Commanded" grow={3}>
          <div className="settings">
            {state.zones.map((zone) => (
              <div className="setting" key={zone}>
                <span className="setting-label">
                  {words(zone)}
                  {state.lit[zone] === "mixed" && <span className="setting-note">Mixed: its LEDs differ.</span>}
                </span>
                <div className="seg seg-wrap" data-enabled={open}>
                  {state.colors.map((color) => {
                    const lit = state.lit[zone] === color;
                    return (
                      <button
                        key={color}
                        className={lit ? "chooser chooser-on" : "chooser"}
                        disabled={!open}
                        onClick={() => guard(allpixel.act("fill", { zone, color }))}
                      >
                        <span className="chooser-lamp" style={lampStyle(lampColor(color), lit ? "on" : "off", 12)} />
                        {words(color)}
                      </button>
                    );
                  })}
                  <button
                    className={state.lit[zone] === "off" ? "chooser chooser-on" : "chooser"}
                    disabled={!open}
                    onClick={() => guard(allpixel.act("fill", { zone, color: "off" }))}
                  >
                    Off
                  </button>
                </div>
              </div>
            ))}
            <div className="setting">
              <span className="setting-label">
                Whole string
                <span className="setting-note">Including the hidden LEDs inside the cabinet.</span>
              </span>
              <button className="alloff" disabled={!open} onClick={() => guard(allpixel.act("all-off"))}>All off</button>
            </div>
          </div>
        </Card>
      </div>

      <div className="col col-narrow">
        <Card title="Device" aside={state.boardId === null ? "Not read" : undefined}>
          <dl className="fields">
            <div className="field">
              <dt>Board id</dt>
              <dd>{state.boardId ?? "—"}</dd>
            </div>
            <div className="field">
              <dt>Layout</dt>
              <dd>{`Embross V1, ${state.ledCount} LEDs`}</dd>
            </div>
          </dl>
        </Card>
        {aside}
      </div>
    </>
  );
}

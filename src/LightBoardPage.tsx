import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Action, Door, LightBoardState, LogEntry } from "./api.ts";
import * as api from "./api.ts";
import type { Commanded, Control } from "./lightboardControls.ts";
import { controlsFor, fullName, modeOf, requestFor, towerMode } from "./lightboardControls.ts";
import { LAMP, lampColor, lampStyle, segStyle, stripPreviewStyle } from "./look.ts";
import { Card, StatusPill } from "./ui.tsx";

/**
 * The light board's controls.
 *
 * The lamps show what was **commanded**. The board acknowledges commands and never reports lamp
 * state, so that is the honest thing for a control panel to show; it clears whenever the port closes.
 */
export function LightBoardPage(
  { state, onFail, aside }: { state: LightBoardState; onFail: (message: string) => void; aside: ReactNode },
) {
  const [commanded, setCommanded] = useState<Commanded>({});
  const open = state.status === "open";
  const wasOpen = useRef(open);

  // A closed port commands nothing, and a reconnected board starts dark.
  useEffect(() => {
    if (!open && wasOpen.current) setCommanded({});
    wasOpen.current = open;
  }, [open]);

  const controls = useMemo(() => controlsFor(state.vocabulary), [state.vocabulary]);

  const send = useCallback((control: Control, action: Action) => {
    setCommanded((previous) => ({ ...previous, [control.key]: action }));
    api.lightboard.led(requestFor(control.base, action)).catch((err: Error) => onFail(err.message));
  }, [onFail]);

  // Everything the commanded-on strip colours light, together. Two colours can share a primary, so
  // this is a set — cyan and blue both on is still just green + blue.
  const litPrimaries = [...new Set(
    controls.strip
      .filter((control) => modeOf(commanded, control.key) === "on")
      .flatMap((control) => control.primaries ?? []),
  )];

  return (
    <>
      <div className="col col-wide">
        <Card title="Component indicators" aside="One indicator each" grow={5}>
          <div className="indicators">
            {controls.indicators.map((control) => (
              <LampControl
                key={control.key}
                control={control}
                mode={modeOf(commanded, control.key)}
                color={LAMP.amber}
                enabled={open}
                onSend={send}
              />
            ))}
          </div>
        </Card>

        <div className="pair" style={{ flex: "3 1 auto" }}>
          <Card title="Bag tag printer" aside="Two sides">
            {controls.bagTag.map((control) => (
              <LampControl
                key={control.key}
                control={control}
                mode={modeOf(commanded, control.key)}
                color={LAMP.amber}
                enabled={open}
                onSend={send}
              />
            ))}
          </Card>

          <Card title="Semaphore tower" aside="Yellow = red + green">
            <div className="sem">
              <div className="tower">
                <span style={lampStyle(LAMP.red, towerMode(commanded, "red"), 30)} />
                <span style={lampStyle(LAMP.green, towerMode(commanded, "green"), 30)} />
                <span className="tower-base" />
              </div>
              <div className="sem-rows">
                {controls.semaphore.map((control) => (
                  <TowerControl
                    key={control.key}
                    control={control}
                    mode={modeOf(commanded, control.key)}
                    enabled={open}
                    onSend={send}
                  />
                ))}
              </div>
            </div>
          </Card>
        </div>

        <Card title="LED strip" aside="On / off per colour" grow={2}>
          <div className="strip">
            <div className="strip-rows">
              {controls.strip.map((control) => (
                <StripControl
                  key={control.key}
                  control={control}
                  mode={modeOf(commanded, control.key)}
                  color={lampColor(control.label)}
                  enabled={open}
                  onSend={send}
                />
              ))}
            </div>
            <div className="strip-preview" style={stripPreviewStyle(litPrimaries, state.vocabulary.stripColors)} />
          </div>
        </Card>
      </div>

      <div className="col col-narrow">
        <Card title="Service doors" aside="Reported">
          {(["upper", "lower"] as Door[]).map((door) => (
            <div className="doorrow" key={door}>
              <span style={lampStyle(LAMP.amber, state.doors[door] === "open" ? "on" : "off", 16)} />
              <span className="doorlabel">{door === "upper" ? "Upper" : "Lower"} service door</span>
              <span className={state.doors[door] === "open" ? "doorstate doorstate-open" : "doorstate"}>
                {state.doors[door] === "open" ? "Open" : "Closed"}
              </span>
            </div>
          ))}
          {state.mock && (
            <div className="doorsim">
              <span className="doorsim-label">Simulate switch</span>
              {(["upper", "lower"] as Door[]).map((door) => (
                <button
                  key={door}
                  onClick={() => api.lightboard.simulateDoor(door).catch((err: Error) => onFail(err.message))}
                  disabled={!open}
                >
                  {door === "upper" ? "Upper" : "Lower"}
                </button>
              ))}
            </div>
          )}
        </Card>
        {aside}
      </div>
    </>
  );
}

/** The header cluster for this device: the port, the connection, and darkening the board. */
export function LightBoardControls(
  { state, onFail }: { state: LightBoardState; onFail: (message: string) => void },
) {
  const [portName, setPortName] = useState(state.portName);
  const open = state.status === "open";
  const opening = state.status === "opening";

  useEffect(() => setPortName(state.portName), [state.portName]);

  const toggle = () => {
    if (open) api.lightboard.disconnect().catch((err: Error) => onFail(err.message));
    // A refused connection is already explained in the activity log by the backend.
    else if (!opening) api.lightboard.connect(portName).catch(() => {});
  };

  return (
    <>
      <div className="bar-group">
        <div className="portbox">
          <label htmlFor="port">Port</label>
          <input
            id="port"
            value={state.mock ? "mock" : portName}
            onChange={(event) => setPortName(event.target.value.toUpperCase())}
            disabled={open || opening || state.mock}
            spellCheck={false}
          />
          <span className="baud">9600 8N1</span>
        </div>
        <button className={open ? "connect connect-open" : "connect"} onClick={toggle} disabled={opening}>
          {open ? "Disconnect" : opening ? "Opening…" : "Connect"}
        </button>
      </div>

      <StatusPill status={state.status} open="Connected · handshake OK" opening="Opening port" shut="Not connected" />

      <button
        className="alloff"
        onClick={() => api.lightboard.allOff().catch((err: Error) => onFail(err.message))}
        disabled={!open}
      >
        All Off
      </button>
    </>
  );
}

/**
 * A light board command, in the words the page uses.
 *
 * The backend records a send as the request it put on the wire, which reads like a wire dump. Only
 * commands are rephrased; anything the board said is shown exactly as it arrived.
 */
export function phrase(entry: LogEntry): string {
  if (entry.kind !== "sent") return entry.text;
  try {
    const request = JSON.parse(entry.text) as Record<string, string>;
    const { section, action, ...rest } = request;
    const what = fullName(section, Object.values(rest)[0]);
    const verb = action === "off" ? "off" : action === "blink" ? "blinking" : "on";
    return `${what} — ${verb}`;
  }
  catch {
    // `allOff` and anything else that is not a request. It is already a phrase.
    return entry.text;
  }
}

/**
 * What every control needs to drive its section.
 *
 * The variants below differ only in what they render around this; each is explicit about what it
 * shows, rather than one component switching on flags.
 */
interface Driven {
  control: Control;
  mode: Action;
  enabled: boolean;
  onSend: (control: Control, action: Action) => void;
}

/** A control with its own lamp: the component indicators and the bag-tag sides. */
function LampControl({ control, mode, color, enabled, onSend }: Driven & { color: string }) {
  return (
    <div className="ctl">
      <span style={lampStyle(color, mode)} />
      <ControlName control={control} />
      <Segments control={control} mode={mode} enabled={enabled} onSend={onSend} />
    </div>
  );
}

/** A semaphore colour. No lamp of its own: the tower beside it shows both lamps. */
function TowerControl({ control, mode, enabled, onSend }: Driven) {
  return (
    <div className="ctl">
      <ControlName control={control} />
      <Segments control={control} mode={mode} enabled={enabled} onSend={onSend} />
    </div>
  );
}

/** A strip colour. Flows inline with the other colours, above the preview. */
function StripControl({ control, mode, color, enabled, onSend }: Driven & { color: string }) {
  return (
    <div className="ctl ctl-inline">
      <span style={lampStyle(color, mode)} />
      <ControlName control={control} />
      <Segments control={control} mode={mode} enabled={enabled} onSend={onSend} />
    </div>
  );
}

function ControlName({ control }: { control: Control }) {
  return (
    <>
      <span className="ctl-label">{control.label}</span>
      <span className="chip">ch {control.channel}</span>
    </>
  );
}

/** On / Blink / Off. Which segments exist comes from the control's own actions. */
function Segments({ control, mode, enabled, onSend }: Driven) {
  // Derived, so a strip control cannot grow a Blink button.
  const segments = control.actions.includes("blink")
    ? [["on", "On"], ["blink", "Blink"], ["off", "Off"]] as const
    : [["on", "On"], ["off", "Off"]] as const;

  return (
    <div className="seg" data-enabled={enabled}>
      {segments.map(([action, text]) => (
        <button
          key={action}
          style={segStyle({ active: mode === action, off: action === "off", enabled })}
          disabled={!enabled}
          onClick={() => onSend(control, action)}
          aria-label={`${control.fullLabel} ${text}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

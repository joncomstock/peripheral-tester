import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Action, Door, LogEntry, State, Status } from "./api.ts";
import * as api from "./api.ts";
import type { Commanded, Control } from "./rows.ts";
import { controlsFor, fullName, modeOf, requestFor, towerMode } from "./rows.ts";
import { LAMP, lampColor, lampStyle, segStyle, stripPreviewStyle, toneOf } from "./look.ts";

const MAX_LINES = 200;

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("closed");
  const [portName, setPortName] = useState("");
  const [doors, setDoors] = useState<Record<Door, string>>({ upper: "closed", lower: "closed" });
  const [log, setLog] = useState<LogEntry[]>([]);
  const [commanded, setCommanded] = useState<Commanded>({});
  const wasOpen = useRef(false);

  useEffect(() => {
    let live = true;
    api.getState()
      .then((loaded) => {
        if (!live) return;
        setState(loaded);
        setStatus(loaded.status);
        setPortName(loaded.portName);
        setDoors(loaded.doors);
        setLog(loaded.log.slice(-MAX_LINES));
      })
      .catch((err: Error) => {
        if (live) setUnreachable(err.message);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    return api.subscribe(
      (event) => {
        if (event.type === "log") {
          setLog((previous) => [...previous, event.entry].slice(-MAX_LINES));
          return;
        }
        setStatus(event.status);
        setPortName(event.portName);
        setDoors(event.doors);
      },
      (message) => setLog((previous) => [...previous, { at: "", kind: "error", text: message }].slice(-MAX_LINES)),
    );
  }, [state]);

  // Nothing is commanded on a board that is not open, and a reconnected board starts dark.
  useEffect(() => {
    if (status === "open") wasOpen.current = true;
    else if (wasOpen.current) {
      wasOpen.current = false;
      setCommanded({});
    }
  }, [status]);

  const controls = useMemo(() => (state ? controlsFor(state.vocabulary) : null), [state]);
  const open = status === "open";
  const opening = status === "opening";

  const complain = useCallback((err: Error) => {
    setLog((previous) => [...previous, { at: "", kind: "failed", text: err.message }].slice(-MAX_LINES));
  }, []);

  const send = useCallback((control: Control, action: Action) => {
    setCommanded((previous) => ({ ...previous, [control.key]: action }));
    api.sendLed(requestFor(control.base, action)).catch(complain);
  }, [complain]);

  const allOff = useCallback(() => {
    setCommanded({});
    api.sendAllOff().catch(complain);
  }, [complain]);

  const toggleConnection = useCallback(() => {
    if (open) api.disconnect().catch(complain);
    // A refused connection is already explained in the activity log by the backend.
    else if (!opening) api.connect(portName).catch(() => {});
  }, [open, opening, portName, complain]);

  if (unreachable) {
    return (
      <div className="gate">
        <h1>Backend not answering</h1>
        <p className="gate-detail">{unreachable}</p>
        <p>
          It holds the COM handle, and the browser cannot reach the board without it. Start it with{" "}
          <code>deno task dev</code>, or <code>deno task dev:mock</code> for no hardware.
        </p>
      </div>
    );
  }

  if (!state || !controls) return <div className="gate"><p>Loading…</p></div>;

  const litStrip = controls.strip
    .filter((control) => modeOf(commanded, control.key) === "on")
    .map((control) => lampColor(control.label));

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <span className="mark" />
          <span className="brand-text">
            <span className="brand-name">Light Board Tester</span>
            <span className="brand-model">IER 919 · S33380</span>
          </span>
        </div>

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
          <button className={`connect${open ? " connect-open" : ""}`} onClick={toggleConnection} disabled={opening}>
            {open ? "Disconnect" : opening ? "Opening…" : "Connect"}
          </button>
        </div>

        <div className="statuspill">
          <span
            className={opening ? "statusdot statusdot-opening" : "statusdot"}
            style={{
              background: open ? LAMP.green : opening ? LAMP.amber : "#c3c9cf",
              boxShadow: open ? `0 0 6px color-mix(in oklab, ${LAMP.green} 55%, transparent)` : "none",
            }}
          />
          <span>{open ? "Connected · handshake OK" : opening ? "Opening port" : "Not connected"}</span>
        </div>

        <button className="alloff" onClick={allOff} disabled={!open}>All Off</button>
      </header>

      <main className="main">
        <div className="col col-wide">
          <Card title="Component indicators" aside="One indicator each">
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

          <div className="pair">
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
                  <span style={lampStyle(LAMP.red, towerMode(commanded, "red"), 19)} />
                  <span style={lampStyle(LAMP.green, towerMode(commanded, "green"), 19)} />
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

          <Card title="LED strip" aside="On / off per colour">
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
              <div className="strip-preview" style={stripPreviewStyle(litStrip)} />
            </div>
          </Card>
        </div>

        <div className="col col-narrow">
          <Card title="Service doors" aside="Reported">
            {(["upper", "lower"] as Door[]).map((door) => (
              <div className="doorrow" key={door}>
                <span style={lampStyle(LAMP.amber, doors[door] === "open" ? "on" : "off", 10)} />
                <span className="doorlabel">{door === "upper" ? "Upper" : "Lower"} service door</span>
                <span className={doors[door] === "open" ? "doorstate doorstate-open" : "doorstate"}>
                  {doors[door] === "open" ? "Open" : "Closed"}
                </span>
              </div>
            ))}
            {state.mock && (
              <div className="doorsim">
                <span className="doorsim-label">Simulate switch</span>
                {(["upper", "lower"] as Door[]).map((door) => (
                  <button key={door} onClick={() => api.simulateDoor(door).catch(complain)} disabled={!open}>
                    {door === "upper" ? "Upper" : "Lower"}
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card title="Activity" action={<button className="clear" onClick={() => setLog([])}>Clear</button>}>
            <div className="activity">
              {log.length === 0
                ? <div className="activity-empty">Nothing yet.</div>
                : [...log].reverse().map((entry, index) => (
                  <div className="activity-line" key={index}>
                    <span className="activity-time">{entry.at}</span>
                    <span className={`activity-text tone-${toneOf(entry.kind)}`}>{phrase(entry)}</span>
                  </div>
                ))}
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}

/**
 * A command, in the words the page uses.
 *
 * The backend records a send as the request's JSON, which reads like a wire dump. Only commands are
 * rephrased; anything the board said is shown exactly as it arrived.
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

function Card(
  { title, aside, action, children }: {
    title: string;
    aside?: string;
    action?: ReactNode;
    children: ReactNode;
  },
) {
  return (
    <section className="card">
      <div className="card-head">
        <span className="tab" />
        <h2>{title}</h2>
        {aside && <span className="card-aside">{aside}</span>}
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * What every control needs to drive its section.
 *
 * The variants below differ only in what they render around this; each is explicit about what it
 * shows, rather than one component switching on flags. `bare` and `inline` booleans used to do that
 * job, which allowed a combination that meant nothing and left `color` optional in a type where it
 * was only ever optional for one of the three.
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
      {segments.map(([action, text], index) => (
        <button
          key={action}
          style={segStyle({ active: mode === action, off: action === "off", first: index === 0, enabled })}
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

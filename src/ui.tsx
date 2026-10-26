import type { ReactNode } from "react";
import type { BaseState } from "./api.ts";
import { LAMP } from "./look.ts";

/**
 * A titled panel.
 *
 * `grow` is a share of the column's spare vertical height — the screens divide what is left over
 * rather than leaving the bottom of a kiosk display empty. Omitted means "only as tall as needed".
 */
export function Card(
  { title, aside, action, grow, children }: {
    title: string;
    aside?: string;
    action?: ReactNode;
    grow?: number;
    children: ReactNode;
  },
) {
  return (
    <section className="card" style={grow ? { flex: `${grow} 1 auto` } : undefined}>
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

/** A connection state, worded by whichever device is showing. Shared chrome, not one device's. */
export function StatusPill(
  { status, open, opening, shut }: { status: string; open: string; opening: string; shut: string },
) {
  const isOpen = status === "open";
  const isOpening = status === "opening";
  return (
    <div className="statuspill">
      <span
        className={isOpening ? "statusdot statusdot-opening" : "statusdot"}
        style={{
          background: isOpen ? LAMP.green : isOpening ? LAMP.amber : "var(--pill-off)",
          boxShadow: isOpen ? `0 0 6px color-mix(in oklab, ${LAMP.green} 55%, transparent)` : "none",
        }}
      />
      <span>{isOpen ? open : isOpening ? opening : shut}</span>
    </div>
  );
}


/**
 * The header cluster any device can use: its bus, Connect / Disconnect, and the connection state.
 *
 * A failed connect is reported through `onFail` as well as the backend's activity line, so a device
 * that is not there says so where the operator is looking.
 */
export function DeviceControls(
  { state, bus, onConnect, onDisconnect, onFail }: {
    state: BaseState;
    bus: string;
    onConnect: () => Promise<unknown>;
    onDisconnect: () => Promise<unknown>;
    onFail: (message: string) => void;
  },
) {
  const open = state.status === "open";
  const opening = state.status === "opening";
  const toggle = () => {
    if (open) onDisconnect().catch((err: Error) => onFail(err.message));
    else if (!opening) onConnect().catch((err: Error) => onFail(`Could not connect: ${err.message}`));
  };

  return (
    <>
      <div className="bar-group">
        <div className="portbox">
          <label htmlFor="bus">Bus</label>
          <input id="bus" value={state.mock ? "mock" : bus} disabled readOnly />
          <span className="baud">{state.usbId}</span>
        </div>
        <button className={open ? "connect connect-open" : "connect"} onClick={toggle} disabled={opening}>
          {open ? "Disconnect" : opening ? "Opening…" : "Connect"}
        </button>
      </div>
      <StatusPill status={state.status} open="Connected" opening="Opening" shut="Not connected" />
    </>
  );
}

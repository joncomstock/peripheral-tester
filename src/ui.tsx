import type { ReactNode } from "react";
import type { Status } from "./api.ts";
import { LAMP } from "./look.ts";

/**
 * A titled panel.
 *
 * `grow` is a share of the column's spare vertical height — the screens divide what is left over
 * rather than leaving the bottom of a kiosk display empty. Omitted means "only as tall as needed".
 *
 * `quiet` is the second heading weight: a panel that supports the one above it rather than
 * competing with it. Two weights and no more, so a screen has one thing it is obviously about.
 */
export function Card(
  { title, aside, action, grow, quiet, children }: {
    title: string;
    aside?: ReactNode;
    action?: ReactNode;
    grow?: number;
    quiet?: boolean;
    children: ReactNode;
  },
) {
  return (
    <section className="card" style={grow ? { flex: `${grow} 1 auto` } : undefined}>
      <div className={quiet ? "card-head card-head--quiet" : "card-head"}>
        {!quiet && <span className="tab" />}
        <h2>{title}</h2>
        {aside !== undefined && <span className="card-aside">{aside}</span>}
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The strip above a device's screen: where it is, whether it is connected, and the two controls
 * that belong to the connection rather than to the device.
 *
 * One per device rather than one in the masthead. The masthead is the tester; this is the
 * peripheral, and putting the port beside the port's own controls is what makes it obvious that
 * Connect and Disconnect act on this device and not on all of them.
 */
export function DeviceBar(
  { label, address, meta, status, open, opening, shut, hint, children }: {
    label: string;
    /** The port, the USB id, the API — editable on the one device where it is a choice. */
    address: ReactNode;
    meta: string;
    status: Status;
    open: string;
    opening: string;
    shut: string;
    /** Shown only while disconnected: what connecting will make possible. */
    hint?: string;
    children: ReactNode;
  },
) {
  const isOpen = status === "open";
  const isOpening = status === "opening";
  return (
    <div className="devbar">
      <div className="addressbox">
        <span className="addressbox-label">{label}</span>
        {address}
        <span className="addressbox-meta" title={meta}>{meta}</span>
      </div>

      <div className="statuspill">
        <span
          className={isOpening ? "statusdot statusdot-opening" : "statusdot"}
          style={{
            background: isOpen ? LAMP.green : isOpening ? LAMP.amber : "var(--off2)",
            boxShadow: isOpen ? `0 0 8px color-mix(in oklab, ${LAMP.green} 55%, transparent)` : "none",
          }}
        />
        <span>{isOpen ? open : isOpening ? opening : shut}</span>
      </div>

      {!isOpen && hint && <span className="devbar-hint">{hint}</span>}

      <div className="devbar-actions">{children}</div>
    </div>
  );
}

/** A labelled row in a settings panel: name on the left, the control that changes it on the right. */
export function Row({ label, chip, children }: { label: string; chip?: string; children: ReactNode }) {
  return (
    <div className="setting">
      <span className="setting-label">{label}</span>
      {chip && <span className="chip">{chip}</span>}
      {children}
    </div>
  );
}

/** − value + , as one segmented control, so the value cannot be typed out of range. */
export function Stepper(
  { value, enabled, onLess, onMore, less, more }: {
    value: string;
    enabled: boolean;
    onLess: () => void;
    onMore: () => void;
    less: string;
    more: string;
  },
) {
  return (
    <div className="seg" data-enabled={enabled}>
      <button className="chooser" disabled={!enabled} onClick={onLess} aria-label={less}>−</button>
      <span className="stepper-value">{value}</span>
      <button className="chooser" disabled={!enabled} onClick={onMore} aria-label={more}>+</button>
    </div>
  );
}

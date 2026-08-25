import type { ReactNode } from "react";
import type { Status } from "./api.ts";
import { LAMP } from "./look.ts";

/**
 * A titled panel.
 *
 * `grow` is a share of the column's spare vertical height — the screens divide what is left over
 * rather than leaving the bottom of a kiosk display empty. Omitted means "only as tall as needed".
 *
 * `quiet` is the second heading weight, and the rule for which card gets the loud one is: **the
 * card carrying the device's answer, one per screen.** The light board's answer is what its
 * indicators were commanded to; the card reader's is the card data; the passport reader's is the
 * presentation. Everything else — controls, settings, the device panel — is quiet, including the
 * control card that sits *above* the answer on both readers. Reading order is not importance.
 *
 * Two weights and no more, so a screen has one thing it is obviously about.
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
 *
 * `children` is the action pair, and the slot beside Connect means one thing on every screen:
 * **put this device back to a safe idle state.** "All off" darkens every indicator, "Cancel"
 * abandons a monitor cycle, "Reset" re-initialises the scanner. They read as three different
 * verbs because each is the word its own device uses; renaming them to something generic would
 * make the panel less like the hardware, not more consistent.
 */
export function DeviceBar(
  { label, address, meta, status, open, opening, shut, progress, hint, children }: {
    label: string;
    /** The port, the USB id, the API — editable on the one device where it is a choice. */
    address: ReactNode;
    meta: string;
    status: Status;
    open: string;
    opening: string;
    shut: string;
    /**
     * The device's most recent log line, shown in place of `opening` while it opens.
     *
     * Opening is the one wait on this screen with stages the backend already narrates — "Opening
     * COM14 at 9600 8N1", then "Board acknowledged handshake". Surfacing them turns a second of
     * nothing into a sequence, without inventing a progress bar for a duration nobody can predict.
     */
    progress?: string;
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
        {/* Ellipsised at 112px, so the full text has to be reachable by something that is not
            a native tooltip — those never fire on touch or keyboard focus. */}
        <span className="addressbox-meta" data-tip={meta} tabIndex={0}>{meta}</span>
      </div>

      {/*
        * Announced, because connecting is the one thing on this screen that changes without anyone
        * pressing anything — the handle opens, or the device refuses, several hundred milliseconds
        * after the press. Polite: it is a status, not an interruption.
        */}
      <div className="statuspill" role="status" aria-live="polite">
        {/* Tagged like every other lamp: this is the indicator the connect feedback is about, and
            it was the one still changing in a single frame. */}
        <span
          data-lamp=""
          className={isOpening ? "statusdot statusdot-opening" : "statusdot"}
          style={{
            background: isOpen ? LAMP.green : isOpening ? LAMP.amber : "var(--off2)",
            boxShadow: isOpen ? `0 0 8px color-mix(in oklab, ${LAMP.green} 55%, transparent)` : "none",
          }}
        />
        <span>{isOpen ? open : isOpening ? (progress ?? opening) : shut}</span>
      </div>

      {!isOpen && hint && <span className="devbar-hint">{hint}</span>}

      <div className="devbar-actions">{children}</div>
    </div>
  );
}

/**
 * A control that can say why it is unavailable.
 *
 * `title` cannot: browsers do not fire it on a disabled element, and it never appears on keyboard
 * focus or on touch — which is every way this kiosk is driven. The wrapper takes the hover the
 * disabled child cannot, and each call site pairs it with an `aria-label` carrying the same words,
 * because a CSS tooltip is invisible to a screen reader.
 *
 * With no tip there is no wrapper, so an enabled control keeps its own layout.
 */
export function Tip({ tip, children }: { tip?: string; children: ReactNode }) {
  if (tip === undefined) return <>{children}</>;
  return (
    // Focusable, because the control inside is `disabled` and so cannot take focus itself — which
    // means `:focus-within` never fires and a keyboard user could hover-only content they have no
    // way to hover. The disabled child is out of the tab order, so this takes its place rather
    // than adding a stop, and the label says out loud what the tooltip shows.
    //
    // `role="note"` because a bare focusable span is `generic`, where `aria-label` is prohibited
    // and may simply not be exposed. `note` is a structure role that takes a name.
    <span className="tip" data-tip={tip} tabIndex={0} role="note" aria-label={tip}>
      {children}
    </span>
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

/**
 * − value + , as one segmented control, so the value cannot be typed out of range.
 *
 * Takes the same busy props as any other group: both steppers post a setting that round-trips
 * through the device, and with the group hardcoded here they were marking a key nothing rendered —
 * the two controls left looking like dead clicks were the two the marker was written for.
 */
export function Stepper(
  { value, enabled, onLess, onMore, less, more, "aria-busy": waiting }: {
    value: string;
    enabled: boolean;
    onLess: () => void;
    onMore: () => void;
    less: string;
    more: string;
    /** Named rather than collected by a rest spread: JSX does not excess-property-check a spread,
     * so anything at all could have reached the root and quietly overridden `className`. */
    "aria-busy"?: true;
  },
) {
  return (
    <div className="seg" data-enabled={enabled} aria-busy={waiting}>
      <button className="chooser" disabled={!enabled} onClick={onLess} aria-label={less}>−</button>
      <span className="stepper-value">{value}</span>
      <button className="chooser" disabled={!enabled} onClick={onMore} aria-label={more}>+</button>
    </div>
  );
}

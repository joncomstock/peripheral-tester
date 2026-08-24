import type { ReactNode } from "react";
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
          background: isOpen ? LAMP.green : isOpening ? LAMP.amber : "#c3c9cf",
          boxShadow: isOpen ? `0 0 6px color-mix(in oklab, ${LAMP.green} 55%, transparent)` : "none",
        }}
      />
      <span>{isOpen ? open : isOpening ? opening : shut}</span>
    </div>
  );
}


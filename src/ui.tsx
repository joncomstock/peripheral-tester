import type { ReactNode } from "react";

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

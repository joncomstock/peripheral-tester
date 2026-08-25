import { useCallback, useEffect, useRef, useState } from "react";
import { lampFor, lampStyle } from "./look.ts";
import type { Tone } from "./look.ts";

/**
 * Transient confirmations, for the actions whose effect is not on the screen that triggered them.
 *
 * "All off" darkens a board across the room; a sweep finishes while the settings panel it was
 * started from has already closed. Everything durable belongs in Activity — a toast is a receipt,
 * not a record, and it says so by leaving.
 */
export interface Toast {
  id: number;
  text: string;
  tone: Tone;
}

const LIFETIME_MS = 2600;
/** More than this on screen at once and they are being used as a log, which Activity already is. */
const MAX = 3;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // A set, and each entry removes itself when it fires: an array only ever pushed to grew one dead
  // id per toast for as long as the tab stayed open, which on a kiosk is the whole shift.
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const dismiss = useCallback((id: number) => setToasts((previous) => previous.filter((t) => t.id !== id)), []);

  const toast = useCallback((text: string, tone: Tone = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((previous) => [...previous, { id, text, tone }].slice(-MAX));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      dismiss(id);
    }, LIFETIME_MS);
    timers.current.add(timer);
  }, [dismiss]);

  return { toasts, toast, dismiss };
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((entry) => (
        <button
          key={entry.id}
          className={`toast toast--${entry.tone}`}
          /*
           * A failure interrupts; a confirmation waits its turn. Per toast rather than on the
           * container, because one stack carries both and the container's politeness is fixed at
           * the moment the region is created.
           */
          role={entry.tone === "bad" ? "alert" : undefined}
          onClick={() => onDismiss(entry.id)}
        >
          <span data-lamp="" style={lampStyle(lampFor(entry.tone), "on", 10)} />
          <span>{entry.text}</span>
        </button>
      ))}
    </div>
  );
}

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/** Everything that can hold focus, less the things that cannot be tabbed to. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab inside an overlay, and put focus back where it came from on close.
 *
 * Every one of the tester's overlays — the drawer, the settings popover, the device picker and
 * the shortcut sheet — declares `aria-modal`, which tells a screen reader the rest of the page is
 * inert. It does not make it so. Tab was walking straight out of the drawer into the device
 * controls behind it, which on this app means a keyboard user can reach a Connect button they
 * cannot see. Closing then dropped focus onto `<body>`, so the next Tab restarted from the top of
 * the page rather than from the control they opened the overlay with.
 *
 * Returns a ref to put on the overlay's container.
 */
export function useDialog<T extends HTMLElement>(): RefObject<T> {
  // `useRef<T>(null)` rather than `useRef<T | null>` so the result is assignable to a `ref` prop.
  const container = useRef<T>(null);
  /** Captured on mount, because by unmount the element may be gone from the document. */
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null;

    // Focus the first control rather than leaving it on the button behind the scrim: an overlay
    // whose first Tab lands outside it is not trapped in any sense the user can feel.
    container.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const wrap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !container.current) return;
      const stops = [...container.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      /*
       * Focus can be outside the overlay without ever having left it: a control that held it can
       * unmount — the drawer's device-scope tab disables itself, a device row disappears — and the
       * browser drops focus to `<body>`. From there neither edge matches and Tab walked out, so
       * anything not inside is pulled back in first.
       */
      if (!container.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      // Otherwise only the two edges need handling; between them the browser does the right thing.
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener("keydown", wrap);
    return () => {
      document.removeEventListener("keydown", wrap);
      // Only if it is still in the document — a device that disconnected may have taken its own
      // button with it, and focusing a detached node silently sends focus to `<body>` anyway.
      const back = opener.current;
      if (back && document.contains(back)) back.focus();
    };
  }, []);

  return container;
}

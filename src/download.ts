/**
 * Hand a JSON file to the browser.
 *
 * Only ever called with the activity log, which the backend guarantees carries no cardholder or
 * document data — that is the whole reason the log is safe to take off the machine. **Nothing that
 * came back from a read may be passed here.** A PAN or an MRZ written to a Downloads folder is
 * exactly the disk copy the rest of this app exists to avoid, and a file outlives the tab that
 * made it.
 */
export function downloadJson(name: string, payload: unknown): { ok: true } | { ok: false; error: string } {
  try {
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    link.click();
    // Long enough for the download to have started; the object URL pins the blob until it is gone.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return { ok: true };
  }
  catch (err) {
    // A kiosk browser with downloads disabled refuses here. Returned rather than thrown so the
    // caller can say so: a button that silently does nothing reads as a broken button.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

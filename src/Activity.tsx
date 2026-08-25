import { useMemo, useState } from "react";
import type { Device, LogEntry } from "./api.ts";
import { downloadJson } from "./download.ts";
import type { DeviceId } from "./devices.ts";
import { deviceEntry, isWired } from "./devices.ts";
import { toneOf } from "./look.ts";
import { Tip } from "./ui.tsx";
import type { Tone } from "./look.ts";

/** Why the device scope is unavailable. Said once, because a tooltip and a label must not drift. */
const NO_LINES = "This device has no screen yet, so it produces no lines";

/**
 * Short tag shown beside a line when every device's lines are mixed together.
 *
 * A map rather than a condition: with two devices "anything that is not the board is the reader"
 * held, and with a card reader and a passport reader in the same log it stopped holding — both
 * tagged "reader", so a line no longer said which peripheral produced it.
 */
const DEVICE_TAG: Record<Device, string> = {
  system: "system",
  lightboard: "board",
  cardreader: "card",
  passportreader: "passport",
};

/**
 * The activity log, shared by every device.
 *
 * One log tagged by device rather than one per device: an operator working through a kiosk moves
 * between peripherals, and the order things happened in is what is worth reading. The scope filter
 * narrows it to whichever screen is open when that is what you want.
 *
 * **Carries no cardholder or document data.** The backend guarantees that, which is what makes
 * Copy and Export safe to offer here — see `download.ts`.
 *
 * `phrase` lets a device render its own lines in its own words — the light board records a command
 * as the request it sent, which is a wire shape rather than a sentence.
 */
export function Activity(
  { log, view, phrase, onClear, toast }: {
    log: LogEntry[];
    /** The screen that is open, for the "this device" scope. */
    view: DeviceId;
    phrase?: (entry: LogEntry) => string;
    onClear: () => void;
    toast: (text: string, tone?: Tone) => void;
  },
) {
  const [scope, setScope] = useState<"all" | "device">("all");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [copied, setCopied] = useState(false);

  // Phrased and reversed once per new line rather than on every render: phrasing a light board
  // command parses its JSON, so doing it inline re-parsed the whole log on every unrelated change.
  const lines = useMemo(
    () =>
      log
        .map((entry) => ({
          at: entry.at,
          device: entry.device,
          tone: toneOf(entry.kind),
          text: phrase ? phrase(entry) : entry.text,
        }))
        .filter((entry) => scope === "all" || entry.device === view || entry.device === "system")
        .filter((entry) => !issuesOnly || entry.tone === "warn" || entry.tone === "bad")
        .reverse(),
    [log, phrase, scope, view, issuesOnly],
  );

  const copy = () => {
    const text = lines.slice().reverse().map((entry) => `${entry.at}  ${DEVICE_TAG[entry.device]}  ${entry.text}`).join("\n");
    // Clipboard access is refused outside a secure context, and a kiosk served over plain http is
    // one place that bites — so a refusal has to say so. Setting the label back to "Copy" was
    // indistinguishable from never having pressed it.
    const denied = (err: unknown) => toast(`Clipboard refused — ${err instanceof Error ? err.message : String(err)}`, "bad");
    if (!navigator.clipboard) {
      toast("No clipboard here — this page is not in a secure context", "bad");
      return;
    }
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      toast(`${lines.length} lines copied`, "ok");
      setTimeout(() => setCopied(false), 1600);
    }, denied);
  };

  const scoped = scope === "device" ? deviceEntry(view).name : "all devices";

  const exportLog = () => {
    const outcome = downloadJson("tester-activity.json", {
      exportedAt: new Date().toISOString(),
      scope: scoped,
      filter: issuesOnly ? "warnings and errors" : "everything",
      lines: lines.slice().reverse(),
    });
    // A download the browser refused leaves nothing on screen and nothing on disk, so it has to be
    // said out loud — otherwise the only signal is a file that never appears.
    toast(outcome.ok ? "tester-activity.json downloaded" : `Export failed — ${outcome.error}`, outcome.ok ? "ok" : "bad");
  };

  return (
    <>
      <div className="drawer-tools">
        <div className="seg seg--small" data-enabled="true">
          <button className={scope === "all" ? "chooser chooser-on" : "chooser"} onClick={() => setScope("all")}>
            All devices
          </button>
          <Tip tip={isWired(view) ? undefined : NO_LINES}>
            <button
              className={scope === "device" ? "chooser chooser-on" : "chooser"}
              disabled={!isWired(view)}
              aria-label={isWired(view) ? undefined : `This device — unavailable: ${NO_LINES}`}
              onClick={() => setScope("device")}
            >
              This device
            </button>
          </Tip>
        </div>
        <button className={issuesOnly ? "pill pill--warn" : "pill"} onClick={() => setIssuesOnly((was) => !was)}>
          Issues only
        </button>
        <button className={copied ? "pill pill--ok" : "pill"} onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>

      <div className="activity">
        {lines.length === 0
          ? <div className="activity-empty">{log.length === 0 ? "Nothing yet." : "No lines match this filter."}</div>
          : lines.map((entry, index) => (
            <div className="activity-line" key={index}>
              <span className="activity-time">{entry.at}</span>
              <span className="activity-device">{DEVICE_TAG[entry.device]}</span>
              <span className={`activity-text tone-${entry.tone}`}>{entry.text}</span>
            </div>
          ))}
      </div>

      <div className="drawer-foot">
        <span className="drawer-note">
          {scope === "device" ? `Filtered to ${scoped}.` : "One stream, every device."}{" "}
          {/* Not "nothing here is written to disk" — that sentence sat beside the button that
              writes it to disk. What is true is what makes the button safe: the backend keeps this
              in memory and it carries nothing a device read returned. */}
          Held in memory, and free of anything a card or a document said.
        </span>
        <button className="pill" onClick={exportLog}>Export JSON</button>
        <button className="pill" onClick={onClear}>Clear</button>
      </div>
    </>
  );
}

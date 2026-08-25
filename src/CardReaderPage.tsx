import { useCallback, useEffect, useRef, useState } from "react";
import type { CardData, CardReaderState, NextOutcome, ReadDirection, ReadResult } from "./api.ts";
import * as api from "./api.ts";
import { usbId } from "./format.ts";
import { useCommands } from "./pending.ts";
import { LAMP, lampColor, lampStyle, segStyle } from "./look.ts";
import type { Tone } from "./look.ts";
import { Card, DeviceBar, Row, Stepper } from "./ui.tsx";

const TRACK_BITS: { bit: number; label: string }[] = [
  { bit: 1, label: "1" },
  { bit: 2, label: "2" },
  { bit: 4, label: "3" },
];

const DIRECTIONS: { value: ReadDirection; label: string }[] = [
  { value: "none", label: "None" },
  { value: "insertion", label: "Insertion" },
  { value: "back", label: "Withdrawal" },
];

const ARM_LABELS: Record<NextOutcome, string> = {
  card: "Card",
  timeout: "Timeout",
  unreadable: "Read failed",
};

/** Everything after the first four digits, hidden. The last four are what identifies a card. */
function maskPan(pan: string): string {
  if (pan.length <= 4) return pan;
  return "•".repeat(pan.length - 4) + pan.slice(-4);
}

/** Group into fours so a revealed PAN can be read back against the card in hand. */
const spaced = (pan: string) => pan.replace(/(.{4})/g, "$1 ").trim();

/**
 * The raw stripe with **every** PAN the read produced blanked.
 *
 * Every, not the one the driver chose as the summary. `assembleCardData` sets `pan` to
 * `track1?.pan ?? track2?.pan`, and the two are read from separate buffers with no cross-check —
 * `track2PanFrom` Luhn-picks its own suffix whenever the digit run does not end with track 1's
 * number, which is exactly what happens when one track misreads. Blanking only the summary then
 * left the other number sitting in the stripe in full.
 *
 * A misread is the fault this screen exists to find, so it is also the case the masking has to
 * survive — and it is one mock mode cannot produce, because its stripe encodes one PAN twice.
 */
export function maskStripe(raw: string, pans: readonly (string | undefined)[]): string {
  let out = raw;
  for (const pan of new Set(pans.filter((pan): pan is string => pan !== undefined && pan.length > 0))) {
    out = out.replaceAll(pan, "•".repeat(pan.length));
  }
  return out;
}

/**
 * Shortest gap between listen cycles.
 *
 * On a real reader the monitor parks for up to 99 seconds, so this never comes into play. A mock
 * answers at once, and without a floor the loop becomes a request storm that fills the activity
 * log and pegs the backend — which is exactly the mode most of this is exercised in.
 */
const CYCLE_FLOOR_MS = 250;

export function CardReaderPage(
  { state, onFail, toast, progress }: {
    state: CardReaderState;
    onFail: (message: string) => void;
    toast: (text: string, tone?: Tone) => void;
    /** The device's newest log line, shown while it opens. See `DeviceBar`. */
    progress?: string;
  },
) {
  const [card, setCard] = useState<CardData | null>(null);
  const [outcome, setOutcome] = useState<ReadResult["kind"] | null>(null);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  /** Read inside the loop, which outlives the render that started it. */
  const listen = useRef(false);

  const open = state.status === "open";
  const opening = state.status === "opening";
  const { transaction } = state;

  /** Posting a command and saying so while it is in the air — see `useCommands`. */
  // `busy` is already this page's read-in-flight flag, so the helper takes the other name.
  const { send, seg, busy: waiting } = useCommands(open, onFail);

  // A closed reader is not listening, and nothing it read is still on the device.
  useEffect(() => {
    if (open) return;
    listen.current = false;
    setListening(false);
    setCard(null);
    setOutcome(null);
  }, [open]);

  /**
   * One monitor cycle.
   *
   * A previous card stays on screen through a cycle that produced nothing, because "the last card
   * read" is what an operator is comparing against the card in their hand. A cycle that found a
   * card replaces it, and one that found a card it could not decode clears it — showing the last
   * card beside "stripe would not decode" would read as though that card had failed.
   */
  const cycle = useCallback(async (): Promise<boolean> => {
    try {
      const result = await api.cardreader.read();
      setOutcome(result.kind ?? null);
      if (result.kind === "card") {
        setCard(result.card ?? null);
        // Every card starts masked. Revealing is a deliberate act, not a state that persists into
        // the next cardholder.
        setReveal(false);
      }
      else if (result.kind === "readFailed") setCard(null);
      return true;
    }
    catch (err) {
      onFail((err as Error).message);
      return false;
    }
  }, [onFail]);

  const readOnce = async () => {
    if (busy) return;
    setBusy(true);
    await cycle();
    setBusy(false);
  };

  /**
   * Stop reading, whatever started it.
   *
   * The listen flag has to be cleared before the cancel lands, or the loop simply re-arms and the
   * button reads as inert — which is what the device bar's Cancel did until it called this.
   */
  const stop = () => {
    listen.current = false;
    setListening(false);
    return send("cancel", api.cardreader.cancel());
  };

  /**
   * Read cycle after cycle until stopped.
   *
   * A loop over the same one-shot read the button beside it uses, rather than the driver's own
   * `listen()`. That call delivers each card through an event, and the only channel this backend
   * has for pushing to the page is the shared SSE stream that also carries the activity log —
   * which by design never carries a PAN. Keeping every card in the reply to the read that asked
   * for it keeps that guarantee structural instead of a rule someone has to remember.
   */
  const toggleListen = async () => {
    if (listen.current) {
      await stop();
      return;
    }
    if (busy) return;
    listen.current = true;
    setListening(true);
    setBusy(true);
    while (listen.current) {
      const started = Date.now();
      if (!await cycle()) break;
      const rest = CYCLE_FLOOR_MS - (Date.now() - started);
      if (rest > 0) await new Promise((resume) => setTimeout(resume, rest));
    }
    listen.current = false;
    setListening(false);
    setBusy(false);
  };

  const toggle = () => {
    if (open) api.cardreader.disconnect().catch((err: Error) => onFail(err.message));
    else if (!opening) api.cardreader.connect().catch(() => {});
  };

  const setTracks = (bit: number) => {
    const next = transaction.tracks ^ bit;
    // The device needs at least one track to read; zero would arm a read that cannot succeed.
    if (next === 0) {
      toast("At least one track must stay selected", "warn");
      return;
    }
    send("tracks", api.cardreader.settings({ tracks: next }));
  };

  const monitoring = busy;

  /** What a read produced, in a sentence, carrying nothing that was on the card. */
  const announcement = card
    ? `Card read — ${
      [card.track1 && "track 1", card.track2 && "track 2"].filter(Boolean).join(" and ") || "no track decoded"
    }`
    : verdictFor(outcome, open, busy).title;
  /*
   * A card that was present and would not decode interrupts; everything else waits its turn.
   *
   * It is the one outcome that reaches no toast — the request succeeded, the *device* did not —
   * so without this the only failure on the screen was also the only one announced politely. A
   * timeout is not a failure: no card arrived, which is a thing that happens.
   */
  const failed = outcome === "readFailed";

  return (
    <>
      <DeviceBar
        label="USB HID"
        address={
          <span className="addressbox-value">
            {state.mock ? "mock" : `${usbId(state.usb.vendorId)}:${usbId(state.usb.productId)}`}
          </span>
        }
        meta="manual insert"
        status={state.status}
        open="Connected · reader claimed"
        opening="Opening reader"
        progress={progress}
        shut="Not connected"
        hint="Connect to enable the transaction calls"
      >
        <button className="button" {...waiting("cancel")} onClick={stop} disabled={!open}>Cancel</button>
        <button className={open ? "button button--strong" : "button button--primary"} onClick={toggle} disabled={opening}>
          {open ? "Disconnect" : opening ? "Opening…" : "Connect"}
        </button>
      </DeviceBar>

      <main className="pane">
        <div className="col col-wide">
          <Card title="Read control" aside={<code>{state.literals.monitor}</code>} quiet>
            <div className={monitoring ? "phase phase--active" : "phase"}>
              <span
                data-lamp=""
                style={lampStyle(
                  monitoring ? LAMP.amber : outcome === "readFailed" ? LAMP.red : LAMP.green,
                  monitoring ? "blink" : open && outcome ? "on" : "off",
                  14,
                )}
              />
              <span className="phase-label">
                {monitoring ? (listening ? "Listening for cards" : "Waiting for a card") : open ? "Idle" : "Reader not claimed"}
              </span>
              <span className="phase-note">
                {monitoring
                  ? `${state.seconds}s cycle`
                  : outcome === "card"
                  ? "Last cycle returned a card"
                  : outcome === "timeout"
                  ? "Last cycle timed out"
                  : outcome === "readFailed"
                  ? "Last cycle failed to decode"
                  : outcome === "cancelled"
                  ? "Last cycle was cancelled"
                  : ""}
              </span>
            </div>

            <div className="actions">
              <button className="button button--primary" onClick={readOnce} disabled={!open || busy}>Read once</button>
              <button
                className={listening ? "button button--strong" : "button"}
                onClick={toggleListen}
                disabled={!open || (busy && !listening)}
              >
                {listening ? "Stop listening" : "Listen"}
              </button>
              <button
                className="button"
                {...waiting("clear")}
                onClick={() => send("clear", api.cardreader.clear())}
                disabled={!open || busy}
              >
                Clear read data
              </button>
              <button
                className="button"
                {...waiting("reset")}
                onClick={() => send("reset", api.cardreader.reset())}
                disabled={!open || busy}
              >
                Initial reset
              </button>
            </div>

            {/* On the group: the three buttons set one thing, so one round trip is one bar. */}
            {state.mock && (
              <div className="simrow">
                <span className="simrow-label">Simulate · next read</span>
                <span className="run" {...waiting("arm")}>
                  {(Object.keys(ARM_LABELS) as NextOutcome[]).map((next) => (
                    <button
                      key={next}
                      className="button button--small"
                      disabled={!open}
                      onClick={() => send("arm", api.cardreader.arm(next))}
                    >
                      {ARM_LABELS[next]}
                    </button>
                  ))}
                </span>
              </div>
            )}
          </Card>

          <Card
            title="Card data"
            grow={1}
            aside={card ? undefined : "Nothing read yet"}
            action={card
              ? (
                <button className="pill card-head-action" onClick={() => setReveal((was) => !was)}>
                  {reveal ? "Mask PAN" : "Reveal PAN"}
                </button>
              )
              : undefined}
          >
            {/*
              * The *outcome* is announced, not the panel.
              *
              * A live region around the card data spoke the PAN aloud the moment Reveal was
              * pressed — on a kiosk, in a terminal, for a reason that is usually "show it to the
              * person next to me". What a screen reader needs is that a read landed and how it
              * decoded; the number itself is there to be navigated to, deliberately, like the
              * button that unmasked it.
              */}
            <p className="visually-hidden" role="status">{failed ? "" : announcement}</p>
            {/* Two nodes, not one with a switched `aria-live`: politeness is read when the region
                is created, so flipping it on an existing one is not reliably honoured. */}
            <p className="visually-hidden" role="alert">{failed ? announcement : ""}</p>
            {card ? <CardPanel card={card} reveal={reveal} /> : <Empty outcome={outcome} open={open} busy={busy} />}
          </Card>

          <Card title="Transaction settings" aside={<code>{state.literals.prepare}</code>} quiet>
            <Row label="Read direction">
              <div {...seg("direction")}>
                {DIRECTIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    className="chooser"
                    style={segStyle({ active: transaction.direction === value, enabled: open })}
                    disabled={!open}
                    onClick={() => send("direction", api.cardreader.settings({ direction: value }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Row>

            <Row label="ISO tracks" chip={state.literals.read}>
              <div {...seg("tracks")}>
                {TRACK_BITS.map(({ bit, label }) => (
                  <button
                    key={bit}
                    className="chooser"
                    style={segStyle({ active: (transaction.tracks & bit) !== 0, enabled: open })}
                    disabled={!open}
                    aria-label={`Track ${label}`}
                    onClick={() => setTracks(bit)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Row>

            <Row label="Hold the card">
              <div {...seg("locks")}>
                <button
                  className="chooser"
                  style={segStyle({ active: transaction.insertionLock, enabled: open, tint: LAMP.amber })}
                  disabled={!open}
                  onClick={() => send("locks", api.cardreader.settings({ insertionLock: !transaction.insertionLock }))}
                >
                  On insertion
                </button>
                <button
                  className="chooser"
                  style={segStyle({ active: transaction.pullOutLock, enabled: open, tint: LAMP.amber })}
                  disabled={!open}
                  onClick={() => send("locks", api.cardreader.settings({ pullOutLock: !transaction.pullOutLock }))}
                >
                  On withdrawal
                </button>
              </div>
            </Row>

            <Row label="Monitor seconds">
              <Stepper
                {...waiting("seconds")}
                value={`${state.seconds}s`}
                enabled={open && !busy}
                less="less time"
                more="more time"
                onLess={() => send("seconds", api.cardreader.settings({ seconds: state.seconds - 5 }))}
                onMore={() => send("seconds", api.cardreader.settings({ seconds: state.seconds + 5 }))}
              />
            </Row>
          </Card>
        </div>

        <div className="col col-narrow">
          <Card title="Bezel LED" aside={<code>{state.literals.led}</code>} quiet>
            <div className="lamprow">
              <span data-lamp="" style={lampStyle(lampColor(state.led), state.led === "off" ? "off" : "on", 30)} />
              <div {...seg("led")}>
                {state.vocabulary.ledColors.map((color) => (
                  <button
                    key={color}
                    className="chooser"
                    style={segStyle({ active: state.led === color, enabled: open, tint: lampColor(color) })}
                    disabled={!open}
                    onClick={() => send("led", api.cardreader.led(color))}
                  >
                    {color[0].toUpperCase() + color.slice(1)}
                  </button>
                ))}
                <button
                  className="chooser"
                  style={segStyle({ active: state.led === "off", off: true, enabled: open })}
                  disabled={!open}
                  onClick={() => send("led", api.cardreader.led("off"))}
                >
                  Off
                </button>
              </div>
            </div>
          </Card>

          <Card title="Shutter" aside={<code>{state.literals.lock} / {state.literals.unlock}</code>} quiet>
            <div className="actions">
              {/* On the pair, not each button — both drive the one shutter. */}
              <span className="run" {...waiting("shutter")}>
                <button className="button" disabled={!open} onClick={() => send("shutter", api.cardreader.shutter(true))}>
                  Lock
                </button>
                <button className="button" disabled={!open} onClick={() => send("shutter", api.cardreader.shutter(false))}>
                  Unlock
                </button>
              </span>
            </div>
            <p className="masknote">
              Drives the shutter now, as opposed to the transaction locks above, which say what the
              next read should do. The two literals were measured against the vendor DLL — an earlier
              guess had them the wrong way round, which made Lock open the shutter.
            </p>
          </Card>
        </div>
      </main>
    </>
  );
}

/**
 * What a read produced when it produced no card.
 *
 * Split from the rendering so the same words can be spoken: the empty state and the announcement
 * were two descriptions of one outcome, and they would have drifted.
 */
function verdictFor(outcome: ReadResult["kind"] | null, open: boolean, busy: boolean): { title: string; note: string } {
  const [title, note] = !open
    ? ["Reader not claimed", "Connect the reader, start a cycle, then insert a card."]
    : busy
    ? ["Waiting for a card", "Insert a card. The device is watching for one."]
    : outcome === "timeout"
    ? ["Cycle timed out", "The device's own timeout elapsed with no card inserted."]
    : outcome === "cancelled"
    ? ["Read cancelled", "The monitor was interrupted before a card arrived."]
    : outcome === "readFailed"
    ? [
      "Stripe would not decode",
      "A card was present but no rule in the driver's track parser accepted a PAN, so nothing is handed up. Retry the read.",
    ]
    : ["No card read yet", "Claim the reader, start a cycle, then insert a card."];
  return { title, note };
}

function Empty({ outcome, open, busy }: { outcome: ReadResult["kind"] | null; open: boolean; busy: boolean }) {
  const { title, note } = verdictFor(outcome, open, busy);
  return (
    <div className="empty">
      <span className="empty-title">{title}</span>
      <span className="empty-note">{note}</span>
    </div>
  );
}

/**
 * A card that was read.
 *
 * Masked unless asked. The driver hands up an unmasked PAN because truncation policy belongs to
 * whoever knows which scheme applies; on this screen the policy is "show the last four, and only
 * more if someone deliberately asks". Nothing here is logged or stored.
 */
function CardPanel({ card, reveal }: { card: CardData; reveal: boolean }) {
  const pan = card.pan ?? card.track1?.pan ?? card.track2?.pan ?? "";
  const shown = (value?: string) => (value === undefined ? undefined : reveal ? spaced(value) : maskPan(value));
  const shownPan = shown(pan) ?? "";
  // The raw stripe carries the PANs inline, so they are blanked there too when masked.
  const shownRaw = reveal ? card.raw : maskStripe(card.raw, [card.pan, card.track1?.pan, card.track2?.pan]);

  // Each track shows the number read from *its own* buffer. They can disagree — that is the read
  // fault this screen is for — and showing the summary twice hid exactly that.
  const rows: { label: string; value?: string; mono?: boolean }[] = [
    { label: "Track 1 · PAN", value: shown(card.track1?.pan), mono: true },
    { label: "Track 1 · name", value: [card.track1?.surname, card.track1?.firstName].filter(Boolean).join(" / ") || undefined },
    { label: "Track 1 · expiry", value: card.track1?.expiry, mono: true },
    { label: "Track 1 · service code", value: card.track1?.serviceCode, mono: true },
    { label: "Track 1 · discretionary", value: card.track1?.discretionary, mono: true },
    { label: "Track 2 · PAN", value: shown(card.track2?.pan), mono: true },
    { label: "Track 2 · expiry", value: card.track2?.expiry, mono: true },
    { label: "Track 2 · service code", value: card.track2?.serviceCode, mono: true },
    { label: "Track 2 · discretionary", value: card.track2?.discretionary, mono: true },
    { label: "Raw stripe", value: shownRaw, mono: true },
  ];

  return (
    <>
      <div className="headline">
        <div className="headline-field">
          <span className="setting-label">PAN</span>
          <span className="headline-value mono">{shownPan || "—"}</span>
        </div>
        <div className="headline-field">
          <span className="setting-label">Expiry</span>
          <span className="headline-value mono">
            {card.expiry ? `${card.expiry.slice(2)}/${card.expiry.slice(0, 2)}` : "—"}
          </span>
        </div>
        <div className="headline-field">
          <span className="setting-label">Cardholder</span>
          <span className="headline-value">{[card.firstName, card.surname].filter(Boolean).join(" ") || "—"}</span>
        </div>
      </div>

      <div className="fieldlist">
        {rows.map(({ label, value, mono }) => (
          <div className="fieldrow" key={label}>
            <span className="fieldrow-label">{label}</span>
            <span className={mono ? "fieldrow-value mono" : "fieldrow-value"}>{value ?? "not present"}</span>
          </div>
        ))}
      </div>

      <p className="masknote">
        The driver returns the PAN unmasked — truncation policy belongs to whoever knows which scheme
        applies. Masking here is display only, and nothing on this screen is logged or stored.
      </p>
    </>
  );
}

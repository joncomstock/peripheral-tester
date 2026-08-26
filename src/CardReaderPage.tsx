import { useCallback, useEffect, useState } from "react";
import type { CardData, CardReaderState, LedControlMode, NextOutcome, ReadDirection, ReadResult } from "./api.ts";
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
  /**
   * Whether the next colour is sent as a blink.
   *
   * An arming choice rather than a device state: the reader is told "green, blinking" in one
   * command, so there is nothing to toggle on a device that is already lit. `state.ledBlinking` is
   * what it actually ended up doing, and the button reads back from that once a colour has gone.
   */
  const [blinkLed, setBlinkLed] = useState(false);

  /**
   * Listening is the *device's* state, not this page's.
   *
   * An earlier revision looped the one-shot read from here and tracked a local flag. That reported
   * a session this page had started, which is not the same fact — a second tab, or a reload
   * mid-cycle, saw "not listening" while the reader was. The driver has a real `listen()`, and the
   * backend already streams its state, so the answer comes from there.
   */
  const listening = state.listening;

  const open = state.status === "open";
  const opening = state.status === "opening";
  const { transaction } = state;

  /** Posting a command and saying so while it is in the air — see `useCommands`. */
  // `busy` is already this page's read-in-flight flag, so the helper takes the other name.
  const { send, seg, busy: waiting } = useCommands(open, onFail);

  // A closed reader has nothing it read still on the device. Its listening state is the backend's
  // to clear, and it does.
  useEffect(() => {
    if (open) return;
    setCard(null);
    setOutcome(null);
  }, [open]);

  /**
   * Collect a card a listening session left server-side.
   *
   * A session flags that a card is there rather than pushing it: the event stream carries no
   * cardholder data by design, so the card leaves only in the reply to a request that asked for
   * it. That fetch is single-shot, so nothing accumulates on either side.
   */
  useEffect(() => {
    if (!state.cardWaiting) return;
    let live = true;
    api.cardreader.takeCard()
      .then((result) => {
        if (!live || !result.card) return;
        setReveal(false);
        setOutcome("card");
        setCard(result.card);
      })
      .catch((err: Error) => onFail(err.message));
    return () => {
      live = false;
    };
  }, [state.cardWaiting, onFail]);

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
   * Ends a listening session as well as cancelling a single cycle, because the device bar's Cancel
   * is the one control an operator reaches for when the reader will not let go, and it must not
   * matter which of the two started it.
   */
  const stop = async () => {
    if (listening) await send("listen", api.cardreader.stopListening());
    return await send("cancel", api.cardreader.cancel());
  };

  /**
   * Read cycle after cycle until stopped.
   *
   * The driver's own `listen()`, run on the backend, rather than a loop over the one-shot read
   * from here. A session outlives this page — a reload, or a second tab — and only the backend can
   * say whether one is running. Each card is left server-side and collected by the effect above,
   * so no cardholder data reaches the shared event stream.
   */
  const toggleListen = () => {
    if (listening) return send("listen", api.cardreader.stopListening());
    if (busy) return;
    return send("listen", api.cardreader.listen());
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
              <span
                data-lamp=""
                style={lampStyle(lampColor(state.led), state.led === "off" ? "off" : state.ledBlinking ? "blink" : "on", 30)}
              />
              <div {...seg("led")}>
                {state.vocabulary.ledColors.map((color) => (
                  <button
                    key={color}
                    className="chooser"
                    style={segStyle({ active: state.led === color, enabled: open, tint: lampColor(color) })}
                    disabled={!open}
                    onClick={() => send("led", api.cardreader.led(color, blinkLed))}
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
                <button
                  className="chooser"
                  style={segStyle({ active: blinkLed, enabled: open })}
                  disabled={!open}
                  aria-pressed={blinkLed}
                  title="Send the next colour as a 1 Hz blink"
                  onClick={() => setBlinkLed((was) => !was)}
                >
                  Blink
                </button>
              </div>
            </div>

            <Row label="LED control" chip={state.ledMode === "automatic" ? "reader" : "tester"}>
              <div {...seg("ledMode")}>
                {(["manual", "automatic"] as LedControlMode[]).map((mode) => (
                  <button
                    key={mode}
                    className="chooser"
                    style={segStyle({ active: state.ledMode === mode, enabled: open })}
                    disabled={!open}
                    onClick={() => send("ledMode", api.cardreader.ledMode(mode))}
                  >
                    {mode === "manual" ? "Manual" : "Automatic"}
                  </button>
                ))}
              </div>
            </Row>
            <p className="masknote">
              In automatic the reader drives its own indicator from the transaction. Setting a colour
              here takes control back, which is why the buttons above do not read as inert while it
              is on.
            </p>
          </Card>

          <Card title="Shutter" aside={<code>{state.literals.lock} / {state.literals.unlock}</code>} quiet>
            <div className="actions">
              {/* On the pair, not each button — both drive the one shutter. */}
              <span className="run" {...waiting("shutter")}>
                {/*
                  Neither button is ever disabled on the shutter's believed state. The tester only
                  knows what it last sent; if that belief is wrong, the way out still has to work.
                */}
                <button
                  className={state.shutter === "locked" ? "button button--strong" : "button"}
                  disabled={!open}
                  onClick={() => send("shutter", api.cardreader.shutter("locked"))}
                >
                  Lock
                </button>
                <button
                  className="button"
                  disabled={!open}
                  onClick={() => send("shutter", api.cardreader.shutter("unlocked"))}
                >
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

          <Identity state={state} onFail={onFail} />
          <Probe state={state} onFail={onFail} />
        </div>
      </main>
    </>
  );
}

/**
 * What the reader says it is, and the one command that puts its IC contacts down.
 *
 * Read on demand rather than on connect: it is three commands to a device an operator may be
 * mid-transaction with, and nothing else on this page needs the answer.
 */
function Identity({ state, onFail }: { state: CardReaderState; onFail: (message: string) => void }) {
  const [about, setAbout] = useState<{ version: string; serialNumber: string; status: string } | null>(null);
  const open = state.status === "open";
  const { send, busy: waiting } = useCommands(open, onFail);

  return (
    <Card title="Device" aside={about ? undefined : "Not read"} quiet>
      <div className="actions">
        <button
          className="button"
          {...waiting("identity")}
          disabled={!open}
          onClick={() =>
            send(
              "identity",
              api.cardreader.identity().then(({ version, serialNumber, status }) => setAbout({ version, serialNumber, status })),
            )}
        >
          Read identity
        </button>
        <button
          className="button"
          {...waiting("icc")}
          disabled={!open}
          onClick={() => send("icc", api.cardreader.deactivateIcc())}
        >
          IC contacts down
        </button>
      </div>
      {about && (
        <div className="fieldlist">
          {[
            { label: "Version", value: about.version },
            { label: "Serial", value: about.serialNumber },
            { label: "Status", value: about.status },
          ].map(({ label, value }) => (
            <div className="fieldrow" key={label}>
              <span className="fieldrow-label">{label}</span>
              {/* `||`, not `??`: the mock answers in empty strings, which are present but say
                  nothing — an em dash is the honest rendering of both. */}
              <span className="fieldrow-value mono">{value || "—"}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Try an unidentified command and see whether the device accepts it.
 *
 * A picker over the driver's own candidate list, never free text: the device's command space also
 * holds firmware download, tamper and rear-destroy, and the driver excludes those families from the
 * list for that reason. Acceptance is all this can report — what a command *did* is on the hardware,
 * which is why the note tells you to watch it.
 */
function Probe({ state, onFail }: { state: CardReaderState; onFail: (message: string) => void }) {
  const [literal, setLiteral] = useState("");
  const [results, setResults] = useState<{ literal: string; token: string; accepted: boolean }[]>([]);
  const open = state.status === "open";
  const { send, busy: waiting } = useCommands(open, onFail);

  return (
    <Card title="Probe" aside="Unidentified literals" quiet>
      <div className="actions">
        <select
          className="select"
          value={literal}
          onChange={(event) => setLiteral(event.target.value)}
          disabled={!open}
          aria-label="Literal to try"
        >
          <option value="">choose a literal</option>
          {state.candidates.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
        </select>
        <button
          className="button"
          {...waiting("probe")}
          disabled={!open || literal === ""}
          onClick={() =>
            send(
              "probe",
              api.cardreader.probe(literal).then(({ literal: sent, token, accepted }) =>
                // Newest first, and capped: this is a scratchpad, not a log — the activity drawer
                // is where the whole run is kept.
                setResults((previous) => [{ literal: sent, token, accepted }, ...previous].slice(0, 8))
              ),
            )}
        >
          Send
        </button>
      </div>
      <p className="masknote">
        Watch the device. This reports only whether the command was accepted, never what it did.
      </p>
      {results.length > 0 && (
        <div className="fieldlist">
          {results.map((result, index) => (
            <div className="fieldrow" key={`${result.literal}-${index}`}>
              <span className="fieldrow-label mono">{result.literal}</span>
              <span className={result.accepted ? "fieldrow-value tone-warn" : "fieldrow-value tone-muted"}>
                {result.token} {result.accepted ? "accepted" : "refused"}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
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

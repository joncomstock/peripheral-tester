import { useCallback, useEffect, useRef, useState } from "react";
import type { CardData, CardReaderState, NextOutcome, ReadDirection, ReadResult, TransactionSetting } from "./api.ts";
import * as api from "./api.ts";
import type { CardScenario } from "./cardScenarios.ts";
import { CARD_SCENARIOS, incoherence } from "./cardScenarios.ts";
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
  /**
   * The scenario whose read has just finished, when it was one that leaves the card held.
   *
   * Kept so the release is offered where the operator is already looking. Cleared by the next read
   * of any kind, because it describes the card currently in the slot and nothing else.
   */
  const [held, setHeld] = useState<CardScenario | null>(null);
  /**
   * Why the last read threw, if it did.
   *
   * A request that fails reaches a toast, which is gone in a few seconds and takes the only account
   * of what happened with it. The panel is where someone looks after the fact, so it keeps the
   * sentence too. Cleared with the rest of the results when the next read starts.
   */
  const [failure, setFailure] = useState<string | null>(null);
  /** Read inside the loop, which outlives the render that started it. */
  const listen = useRef(false);

  const open = state.status === "open";
  const opening = state.status === "opening";
  const { transaction } = state;

  /** Posting a command and saying so while it is in the air — see `useCommands`. */
  // `busy` is already this page's read-in-flight flag, so the helper takes the other name.
  const { send, seg, busy: waiting } = useCommands(open, onFail);

  // A closed reader is not listening, and nothing it read is still on the device.
  //
  // This clears what `clearResults` clears, for the same reason: a disconnect is a panel-emptying
  // event like a read starting. `reveal` resets so a panel cannot come back unmasked on the path
  // that skipped it, and `failure` resets because `verdictFor` reads it before `open` — a reader
  // that has since been disconnected was otherwise still shown the red "could not be sent".
  useEffect(() => {
    if (open) return;
    listen.current = false;
    setListening(false);
    setCard(null);
    setOutcome(null);
    setHeld(null);
    setFailure(null);
    setReveal(false);
  }, [open]);

  /**
   * Empty the results panel, so nothing on screen belongs to the card before this one.
   *
   * Called as a read starts rather than when one ends. A panel that still shows the last card while
   * the reader waits for the next is the one thing at a bench nobody can afford to misread: the
   * operator is holding a second card and looking at the first one's number.
   *
   * The cost is deliberate. The last card used to survive a cycle that produced nothing, so it
   * could be compared against the card in hand; now a timeout leaves the panel empty. Within a
   * listen loop it still survives — the clear happens once, when listening starts, because clearing
   * per cycle would blink the panel on every pass.
   */
  const clearResults = () => {
    setCard(null);
    setOutcome(null);
    setFailure(null);
    // Revealing is deliberate and resets on the next read; a cleared panel must not come back unmasked.
    setReveal(false);
  };

  /**
   * One monitor cycle.
   *
   * A cycle that found a card replaces what is shown, and one that found a card it could not decode
   * clears it — showing the last card beside "stripe would not decode" would read as though that
   * card had failed.
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
      const message = (err as Error).message;
      setFailure(message);
      onFail(message);
      return false;
    }
  }, [onFail]);

  const readOnce = async () => {
    if (busy) return;
    setBusy(true);
    setHeld(null);
    clearResults();
    await cycle();
    setBusy(false);
  };

  /**
   * The raw diagnostic, run through the same busy flag as a read.
   *
   * It reports into Activity rather than onto the card panel, so without this the page showed
   * nothing at all for the fifteen seconds it waits — an Idle lamp and a live button, which reads
   * as a dead control and gets pressed again. Three overlapping cycles is not a diagnostic.
   */
  const diagnose = async () => {
    if (busy) return;
    setBusy(true);
    clearResults();
    try {
      await api.cardreader.diagnose();
    }
    catch (err) {
      onFail((err as Error).message);
    }
    setBusy(false);
  };

  /**
   * Apply a scenario's whole configuration, then read under it.
   *
   * One `settings` call rather than four: the four fields are a single coherent choice, and posting
   * them separately would put three configurations that nobody chose on the wire on the way to the
   * one that was. The controls below re-render from the state that comes back, so what the scenario
   * picked stays visible and adjustable — it configures the manual panel rather than bypassing it.
   */
  const runScenario = async (scenario: CardScenario) => {
    if (busy) return;
    setBusy(true);
    setHeld(null);
    clearResults();
    try {
      await api.cardreader.settings(scenario.setting);
      const read = await cycle();
      // Only when the read actually happened: a scenario whose request failed has not put a card
      // anywhere, and offering to release one would be a lie.
      if (read && scenario.retains) setHeld(scenario);
    }
    catch (err) {
      const message = (err as Error).message;
      setFailure(message);
      onFail(message);
    }
    setBusy(false);
  };

  const sameSetting = (a: TransactionSetting, b: TransactionSetting) =>
    a.direction === b.direction && a.tracks === b.tracks &&
    a.insertionLock === b.insertionLock && a.pullOutLock === b.pullOutLock;
  /** Which scenario the panel is currently configured as, if any — hand-tuning simply matches none. */
  const activeScenario = CARD_SCENARIOS.find((scenario) => sameSetting(scenario.setting, transaction)) ?? null;

  /** Which end of the delay experiment the panel is currently set to — hand-tuning matches neither. */
  const atZero = state.delays.trackReadDelayMs === 0 && state.delays.clearReadDelayMs === 0;
  const atShipped = state.delays.trackReadDelayMs === state.delays.shipped.trackReadDelayMs &&
    state.delays.clearReadDelayMs === state.delays.shipped.clearReadDelayMs;
  /** Why the current manual configuration cannot read, if it cannot. */
  const configFault = incoherence(transaction);

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
    clearResults();
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
    : verdictFor(outcome, open, busy, failure).title;
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
          <Card title="Scenarios" quiet>
            {/*
              * The cycle's status, at the top of the panel that starts one.
              *
              * It lived in `Read control`, which was the first card until the scenarios took that
              * place. Left there it sat below the fold of the route most people take, saying "Idle"
              * where nobody was looking. `.phase` is styled to head a card, so it needs no new
              * dressing to sit here.
              */}
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
            <p className="masknote">
              Each sets the whole transaction — direction, tracks and both locks — to a combination
              that can actually read, then runs one read under it. The controls below move to match,
              so a scenario is a starting point you can adjust rather than a mode you are put into.
            </p>
            <div className="actions">
              {CARD_SCENARIOS.map((scenario) => (
                <button
                  key={scenario.id}
                  className={activeScenario?.id === scenario.id ? "button button--strong" : "button"}
                  onClick={() => runScenario(scenario)}
                  disabled={!open || busy}
                  title={scenario.hint}
                >
                  {scenario.label}
                </button>
              ))}
            </div>
            {activeScenario && <p className="masknote">{activeScenario.hint}</p>}
            {/*
              * The release is offered here rather than left to the Shutter card below.
              *
              * A retain scenario ends with the card still in the reader, which is the scenario
              * working — but the control that frees it was two cards away under a different
              * heading, so the first person to run one went looking for it with a card stuck in
              * the slot. Nothing releases on its own: this is still a deliberate click.
              */}
            {held && (
              <div className="simrow">
                <span className="simrow-label">Card is held by the reader</span>
                <button
                  className="button button--primary"
                  {...waiting("shutter")}
                  onClick={() => {
                    setHeld(null);
                    return send("shutter", api.cardreader.shutter(false));
                  }}
                  disabled={!open}
                >
                  Release card
                </button>
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
            {card
              ? <CardPanel card={card} reveal={reveal} />
              : <Empty outcome={outcome} open={open} busy={busy} failure={failure} />}
          </Card>

          <Card title="Read control" aside={<code>{state.literals.monitor}</code>} quiet>

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
              {/*
                * Reports the device's own replies rather than a verdict, into Activity.
                *
                * `Read once` can only say a read failed; this says what the device answered, which
                * is what separates a device that refused from a reply this driver declined to use.
                */}
              <button
                className="button"
                {...waiting("diagnose")}
                onClick={diagnose}
                disabled={!open || busy}
                title="Runs one cycle and reports the raw replies in Activity. Waits 15s for a card."
              >
                Diagnostic read
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

          <Card title="Transaction settings" aside={<code>{state.literals.prepare}</code>} quiet>
            {/*
              * The manual controls can still be set to a combination that cannot read — four
              * independent toggles do not say which pairings are contradictory. Saying so beats
              * letting it reach the card as `card present but unreadable`.
              */}
            {configFault && <p className="masknote masknote--warn" role="status">{configFault}</p>}
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

            {/*
              * The two carried-over read delays, which are worth about 700ms a transaction between
              * them and have never been measured away. They are `readonly` on the driver and fixed
              * when the reader is constructed, so these decide the *next* open — `Apply` is what
              * reaches the device. Deliberately a separate action: a reopen does not release the
              * shutter, so doing it automatically would strand a retained card.
              */}
            <Row label="Track read delay" chip={state.delays.pending ? "reopen to apply" : undefined}>
              <Stepper
                {...waiting("trackDelay")}
                value={`${state.delays.trackReadDelayMs}ms`}
                enabled={!busy}
                less="less delay"
                more="more delay"
                onLess={() => send("trackDelay", api.cardreader.delays({ trackReadDelayMs: state.delays.trackReadDelayMs - 50 }))}
                onMore={() => send("trackDelay", api.cardreader.delays({ trackReadDelayMs: state.delays.trackReadDelayMs + 50 }))}
              />
            </Row>

            <Row label="Clear read delay">
              <Stepper
                {...waiting("clearDelay")}
                value={`${state.delays.clearReadDelayMs}ms`}
                enabled={!busy}
                less="less delay"
                more="more delay"
                onLess={() => send("clearDelay", api.cardreader.delays({ clearReadDelayMs: state.delays.clearReadDelayMs - 50 }))}
                onMore={() => send("clearDelay", api.cardreader.delays({ clearReadDelayMs: state.delays.clearReadDelayMs + 50 }))}
              />
            </Row>

            <Row label="Both delays">
              <div {...seg("delays")}>
                <button
                  className="chooser"
                  style={segStyle({ active: atZero, enabled: !busy })}
                  disabled={busy}
                  onClick={() => send("delays", api.cardreader.delays({ trackReadDelayMs: 0, clearReadDelayMs: 0 }))}
                >
                  Both to 0
                </button>
                <button
                  className="chooser"
                  style={segStyle({ active: atShipped, enabled: !busy })}
                  disabled={busy}
                  onClick={() => send("delays", api.cardreader.delays(state.delays.shipped))}
                >
                  Shipped
                </button>
                <button
                  className="chooser"
                  style={segStyle({ active: false, enabled: state.delays.pending && !busy })}
                  disabled={!state.delays.pending || busy}
                  onClick={() => send("delays", api.cardreader.reopen())}
                >
                  Apply
                </button>
              </div>
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
/**
 * What the panel says when it is not showing a card.
 *
 * Every one of these is an answer, so each gets its own sentence and its own weight rather than a
 * single grey "nothing here". A request that threw is the newest of them: it used to reach a toast
 * and nothing else, so the account of what went wrong expired a few seconds after it appeared.
 *
 * The tone separates "no card arrived", which is a thing that happens on an idle kiosk, from "a
 * card was there and something went wrong", which is what someone at a bench is hunting.
 */
function verdictFor(
  outcome: ReadResult["kind"] | null,
  open: boolean,
  busy: boolean,
  failure?: string | null,
): { title: string; note: string; tone: "quiet" | "warn" | "bad" } {
  if (failure) {
    return {
      title: "The read could not be sent",
      note: `${failure}. The device was not asked, so nothing was read — this is the app or the driver, not the card.`,
      tone: "bad",
    };
  }
  const [title, note, tone] = !open
    ? ["Reader not claimed", "Connect the reader, start a cycle, then insert a card.", "quiet"] as const
    : busy
    ? ["Waiting for a card", "Insert a card. The device is watching for one.", "quiet"] as const
    : outcome === "timeout"
    ? [
      "Cycle timed out",
      "The device's own timeout elapsed with no card inserted. Nothing is wrong with the reader — start another cycle.",
      "quiet",
    ] as const
    : outcome === "cancelled"
    ? ["Read cancelled", "The monitor was interrupted before a card arrived.", "quiet"] as const
    : outcome === "readFailed"
    ? [
      "Stripe would not decode",
      "A card was present but no rule in the driver's track parser accepted a PAN, so nothing is handed up. Retry the read, and use Diagnostic read to see what the device actually replied.",
      "warn",
    ] as const
    : ["No card read yet", "Claim the reader, start a cycle, then insert a card.", "quiet"] as const;
  return { title, note, tone };
}

function Empty(
  { outcome, open, busy, failure }: {
    outcome: ReadResult["kind"] | null;
    open: boolean;
    busy: boolean;
    failure?: string | null;
  },
) {
  const { title, note, tone } = verdictFor(outcome, open, busy, failure);
  return (
    <div className={tone === "quiet" ? "empty" : `empty empty--${tone}`}>
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

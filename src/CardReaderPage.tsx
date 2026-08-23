import { useState } from "react";
import type { ReactNode } from "react";
import type { CardData, CardReaderState, LedColor, NextOutcome, ReadDirection, ReadResult } from "./api.ts";
import * as api from "./api.ts";
import { LAMP, lampStyle } from "./look.ts";
import { Card } from "./ui.tsx";
import { StatusPill } from "./LightBoardPage.tsx";

const TRACK_BITS: { bit: number; label: string }[] = [
  { bit: 1, label: "Track 1" },
  { bit: 2, label: "Track 2" },
  { bit: 4, label: "Track 3" },
];

const DIRECTIONS: { value: ReadDirection; label: string }[] = [
  { value: "back", label: "On withdrawal" },
  { value: "insertion", label: "On insertion" },
  { value: "none", label: "No reading" },
];

/** Everything after the first four digits, hidden. The last four are what identifies a card. */
function maskPan(pan: string): string {
  if (pan.length <= 4) return pan;
  return "•".repeat(pan.length - 4) + pan.slice(-4);
}

/** Group into fours so a revealed PAN can be read back against the card in hand. */
const spaced = (pan: string) => pan.replace(/(.{4})/g, "$1 ").trim();

export function CardReaderPage(
  { state, onFail, aside }: { state: CardReaderState; onFail: (message: string) => void; aside: ReactNode },
) {
  const [card, setCard] = useState<CardData | null>(null);
  const [outcome, setOutcome] = useState<ReadResult["kind"] | null>(null);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);

  const open = state.status === "open";
  const { transaction } = state;

  const guard = (work: Promise<unknown>) => work.catch((err: Error) => onFail(err.message));

  const read = async () => {
    setBusy(true);
    setCard(null);
    setOutcome(null);
    // Every read starts masked. Revealing is a deliberate act, not a state that persists into the
    // next card.
    setReveal(false);
    try {
      const result = await api.cardreader.read();
      setOutcome(result.kind ?? null);
      setCard(result.card ?? null);
    }
    catch (err) {
      onFail((err as Error).message);
    }
    finally {
      setBusy(false);
    }
  };

  const setTracks = (bit: number) => {
    const next = transaction.tracks ^ bit;
    // The device needs at least one track to read; zero would arm a read that cannot succeed.
    if (next === 0) return;
    guard(api.cardreader.settings({ tracks: next }));
  };

  return (
    <>
      <div className="col col-wide">
        <Card title="Read a card" aside={state.literals.monitor} grow={4}>
          <div className="readpane">
            <div className="readpane-actions">
              <button className="primary" onClick={read} disabled={!open || busy}>
                {busy ? "Waiting for a card…" : `Read once · ${state.seconds}s`}
              </button>
              <button onClick={() => guard(api.cardreader.cancel())} disabled={!open || !busy}>Cancel</button>
              <button onClick={() => guard(api.cardreader.clear())} disabled={!open || busy}>Clear read data</button>
              <button onClick={() => guard(api.cardreader.reset())} disabled={!open || busy}>Initial reset</button>
            </div>

            {card
              ? <CardPanel card={card} reveal={reveal} onReveal={() => setReveal((was) => !was)} />
              : <Verdict outcome={outcome} busy={busy} open={open} />}
          </div>
        </Card>

        <Card title="Transaction settings" aside={state.literals.prepare} grow={3}>
          <div className="settings">
            <div className="setting">
              <span className="setting-label">Read direction</span>
              <div className="seg" data-enabled={open}>
                {DIRECTIONS.map(({ value, label }, index) => (
                  <button
                    key={value}
                    className={transaction.direction === value ? "chooser chooser-on" : "chooser"}
                    style={index === 0 ? undefined : { borderLeft: "1px solid #e2e6ea" }}
                    disabled={!open}
                    onClick={() => guard(api.cardreader.settings({ direction: value }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting">
              <span className="setting-label">Tracks</span>
              <div className="seg" data-enabled={open}>
                {TRACK_BITS.map(({ bit, label }, index) => (
                  <button
                    key={bit}
                    className={(transaction.tracks & bit) !== 0 ? "chooser chooser-on" : "chooser"}
                    style={index === 0 ? undefined : { borderLeft: "1px solid #e2e6ea" }}
                    disabled={!open}
                    onClick={() => setTracks(bit)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting">
              <span className="setting-label">Hold the card</span>
              <div className="seg" data-enabled={open}>
                <button
                  className={transaction.insertionLock ? "chooser chooser-on" : "chooser"}
                  disabled={!open}
                  onClick={() => guard(api.cardreader.settings({ insertionLock: !transaction.insertionLock }))}
                >
                  On insertion
                </button>
                <button
                  className={transaction.pullOutLock ? "chooser chooser-on" : "chooser"}
                  style={{ borderLeft: "1px solid #e2e6ea" }}
                  disabled={!open}
                  onClick={() => guard(api.cardreader.settings({ pullOutLock: !transaction.pullOutLock }))}
                >
                  On withdrawal
                </button>
              </div>
            </div>

            <div className="setting">
              <span className="setting-label">Wait</span>
              <div className="seg" data-enabled={open}>
                <button
                  className="chooser"
                  disabled={!open}
                  onClick={() => guard(api.cardreader.settings({ seconds: state.seconds - 5 }))}
                  aria-label="less time"
                >
                  −5s
                </button>
                <span className="stepper-value">{state.seconds}s</span>
                <button
                  className="chooser"
                  style={{ borderLeft: "1px solid #e2e6ea" }}
                  disabled={!open}
                  onClick={() => guard(api.cardreader.settings({ seconds: state.seconds + 5 }))}
                  aria-label="more time"
                >
                  +5s
                </button>
              </div>
            </div>

            <div className="setting">
              <span className="setting-label">
                Shutter
                <span className="setting-note">
                  Locking holds the card in the machine. Release always stays available.
                </span>
              </span>
              <div className="seg" data-enabled={open}>
                <button
                  className={state.shutter === "locked" ? "chooser chooser-warn" : "chooser"}
                  disabled={!open}
                  onClick={() => guard(api.cardreader.shutter("locked"))}
                >
                  Hold card
                </button>
                {/*
                  Never disabled on the shutter's believed state. The tester only knows what it last
                  commanded, and the pair was documented backwards once — if that belief is wrong,
                  the way out still has to work.
                */}
                <button
                  className={state.shutter === "unlocked" ? "chooser chooser-on" : "chooser"}
                  style={{ borderLeft: "1px solid #e2e6ea" }}
                  disabled={!open}
                  onClick={() => guard(api.cardreader.shutter("unlocked"))}
                >
                  Release
                </button>
              </div>
            </div>

            <div className="setting">
              <span className="setting-label">Indicator</span>
              <div className="seg" data-enabled={open}>
                {(["green", "orange", "red"] as LedColor[]).map((color, index) => (
                  <button
                    key={color}
                    className={state.led === color ? "chooser chooser-on" : "chooser"}
                    style={index === 0 ? undefined : { borderLeft: "1px solid #e2e6ea" }}
                    disabled={!open}
                    onClick={() => guard(api.cardreader.led(color))}
                  >
                    <span style={{ ...lampStyle(LAMP[color], state.led === color ? "on" : "off", 12), marginRight: 8 }} />
                    {color[0].toUpperCase() + color.slice(1)}
                  </button>
                ))}
                <button
                  className={state.led === "off" ? "chooser chooser-on" : "chooser"}
                  style={{ borderLeft: "1px solid #e2e6ea" }}
                  disabled={!open}
                  onClick={() => guard(api.cardreader.led("off"))}
                >
                  Off
                </button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div className="col col-narrow">
        {state.mock && (
          <Card title="Mock reader" aside="No hardware">
            <div className="doorsim">
              <span className="doorsim-label">Next read</span>
              {(["card", "timeout", "unreadable"] as NextOutcome[]).map((next) => (
                <button key={next} disabled={!open} onClick={() => guard(api.cardreader.arm(next))}>
                  {next === "card" ? "Card" : next === "timeout" ? "Timeout" : "Unreadable"}
                </button>
              ))}
            </div>
          </Card>
        )}
        {aside}
      </div>
    </>
  );
}

/** What a read produced when it produced no card. */
function Verdict({ outcome, busy, open }: { outcome: ReadResult["kind"] | null; busy: boolean; open: boolean }) {
  if (!open) return <div className="verdict">Connect the reader to read a card.</div>;
  if (busy) return <div className="verdict">Insert a card. The device is watching for one.</div>;
  if (outcome === "timeout") return <div className="verdict">No card arrived before the wait elapsed.</div>;
  if (outcome === "cancelled") return <div className="verdict">Read cancelled.</div>;
  if (outcome === "readFailed") {
    return (
      <div className="verdict verdict-bad">
        A card was present, but no rule in the track parser accepted a PAN from its stripe. Try the
        read again, or a different card.
      </div>
    );
  }
  return <div className="verdict">Ready.</div>;
}

/**
 * A card that was read.
 *
 * Masked unless asked. The driver hands up an unmasked PAN because truncation policy belongs to
 * whoever knows which scheme applies; on this screen the policy is "show the last four, and only
 * more if someone deliberately asks". Nothing here is logged or stored.
 */
function CardPanel({ card, reveal, onReveal }: { card: CardData; reveal: boolean; onReveal: () => void }) {
  const pan = card.pan ?? card.track1?.pan ?? card.track2?.pan ?? "";
  const shownPan = reveal ? spaced(pan) : maskPan(pan);
  // The raw stripe carries the PAN inline, so it is blanked there too when masked.
  const shownRaw = reveal || !pan ? card.raw : card.raw.replaceAll(pan, "•".repeat(pan.length));

  const rows: { label: string; value?: string }[] = [
    { label: "PAN", value: shownPan },
    { label: "Name", value: [card.surname, card.firstName].filter(Boolean).join(", ") || undefined },
    { label: "Expiry", value: card.expiry ? `${card.expiry.slice(2)}/${card.expiry.slice(0, 2)}` : undefined },
    { label: "Track 1", value: card.track1 ? "decoded" : "not present" },
    { label: "Track 2", value: card.track2 ? "decoded" : "not present" },
  ];

  return (
    <div className="cardpanel">
      <div className="cardpanel-head">
        <span style={lampStyle(LAMP.green, "on", 14)} />
        <span className="cardpanel-title">Card read</span>
        <button className="clear" onClick={onReveal}>{reveal ? "Mask PAN" : "Reveal PAN"}</button>
      </div>

      <dl className="fields">
        {rows.map(({ label, value }) => (
          <div className="field" key={label}>
            <dt>{label}</dt>
            <dd>{value ?? "—"}</dd>
          </div>
        ))}
      </dl>

      <div className="rawstripe">
        <span className="setting-label">Raw stripe</span>
        <code>{shownRaw}</code>
      </div>

      <p className="masknote">
        The driver returns the PAN unmasked — truncation policy belongs to whoever knows which scheme
        applies. Masking here is display only, and nothing on this screen is logged or stored.
      </p>
    </div>
  );
}

/** The header cluster for this device. */
export function CardReaderControls(
  { state, onFail }: { state: CardReaderState; onFail: (message: string) => void },
) {
  const open = state.status === "open";
  const opening = state.status === "opening";

  const toggle = () => {
    if (open) api.cardreader.disconnect().catch((err: Error) => onFail(err.message));
    else if (!opening) api.cardreader.connect().catch(() => {});
  };

  return (
    <>
      <div className="bar-group">
        <div className="portbox">
          <label htmlFor="bus">Bus</label>
          <input id="bus" value={state.mock ? "mock" : "USB HID"} disabled readOnly />
          <span className="baud">0590:0034</span>
        </div>
        <button className={open ? "connect connect-open" : "connect"} onClick={toggle} disabled={opening}>
          {open ? "Disconnect" : opening ? "Opening…" : "Connect"}
        </button>
      </div>

      <StatusPill status={state.status} open="Connected · reader ready" opening="Opening reader" shut="Not connected" />
    </>
  );
}

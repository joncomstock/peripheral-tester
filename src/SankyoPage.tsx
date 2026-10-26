import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { CardData, ReadResult, SankyoState } from "./api.ts";
import * as api from "./api.ts";
import { CardPanel, Verdict } from "./CardReaderPage.tsx";
import { LAMP, lampStyle } from "./look.ts";
import { Card } from "./ui.tsx";

/**
 * The Sankyo ICM330's screen: read a card once, or listen for cards, and drive the bezel LED.
 *
 * Same card rules as the V4K's screen: the card arrives in the reply to the read, or once from the
 * listening session, is masked unless asked, and is never logged or stored.
 */
export function SankyoPage(
  { state, onFail, aside }: { state: SankyoState; onFail: (message: string) => void; aside: ReactNode },
) {
  const [card, setCard] = useState<CardData | null>(null);
  const [outcome, setOutcome] = useState<ReadResult["kind"] | null>(null);
  const [reveal, setReveal] = useState(false);
  const [blink, setBlink] = useState(false);
  const [about, setAbout] = useState<{ deviceName: string; serialNumber: string; revision: string } | null>(null);

  const open = state.status === "open";
  const guard = (work: Promise<unknown>) => work.catch((err: Error) => onFail(err.message));

  const read = async () => {
    setCard(null);
    setOutcome(null);
    setReveal(false);
    try {
      const result = await api.sankyo.read();
      setOutcome(result.kind ?? null);
      setCard(result.card ?? null);
    }
    catch (err) {
      onFail((err as Error).message);
    }
  };

  // As on the V4K's screen: a listened-for card is collected once, as soon as it is flagged.
  useEffect(() => {
    if (!state.cardWaiting) return;
    let live = true;
    api.sankyo.takeCard()
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

  return (
    <>
      <div className="col col-wide">
        <Card title="Read a card" aside={state.listening ? (state.present ? "Card in slot" : "Slot empty") : undefined} grow={4}>
          <div className="readpane">
            <div className="readpane-actions">
              <button className="primary" onClick={read} disabled={!open || state.reading || state.listening}>
                {state.reading ? "Waiting for a card…" : `Read once · ${state.seconds}s`}
              </button>
              {state.listening
                ? <button onClick={() => guard(api.sankyo.stopListening())} disabled={!open}>Stop listening</button>
                : <button onClick={() => guard(api.sankyo.listen())} disabled={!open || state.reading}>Listen</button>}
              <button onClick={() => guard(api.sankyo.cancel())} disabled={!open || !state.reading}>Cancel</button>
            </div>

            {card
              ? <CardPanel card={card} reveal={reveal} onReveal={() => setReveal((was) => !was)} />
              : <Verdict outcome={outcome} busy={state.reading} open={open} />}
          </div>
        </Card>

        <Card title="Settings" grow={2}>
          <div className="settings">
            <div className="setting">
              <span className="setting-label">Wait</span>
              <div className="seg" data-enabled={open}>
                <button className="chooser" disabled={!open} onClick={() => guard(api.sankyo.seconds(state.seconds - 5))} aria-label="less time">
                  −5s
                </button>
                <span className="stepper-value">{state.seconds}s</span>
                <button className="chooser" disabled={!open} onClick={() => guard(api.sankyo.seconds(state.seconds + 5))} aria-label="more time">
                  +5s
                </button>
              </div>
            </div>

            <div className="setting">
              <span className="setting-label">Indicator</span>
              <div className="seg" data-enabled={open}>
                {state.ledColors.filter((color) => color !== "off").map((color) => (
                  <button
                    key={color}
                    className={state.led === color ? "chooser chooser-on" : "chooser"}
                    disabled={!open}
                    onClick={() => guard(api.sankyo.led(color, blink))}
                  >
                    <span style={{ ...lampStyle(LAMP[color], state.led === color ? "on" : "off", 12), marginRight: 8 }} />
                    {color[0].toUpperCase() + color.slice(1)}
                  </button>
                ))}
                <button
                  className={state.led === "off" ? "chooser chooser-on" : "chooser"}
                  disabled={!open}
                  onClick={() => guard(api.sankyo.led("off", false))}
                >
                  Off
                </button>
                <button
                  className={blink ? "chooser chooser-on" : "chooser"}
                  disabled={!open}
                  onClick={() => setBlink((was) => !was)}
                  aria-pressed={blink}
                  title="Apply the next colour as a 1 s blink"
                >
                  Blink
                </button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div className="col col-narrow">
        <Card title="Device" aside={about ? undefined : "Not read"}>
          <div className="doorsim">
            <span className="doorsim-label">Identity</span>
            <button
              disabled={!open || state.reading}
              onClick={() => api.sankyo.identity().then(setAbout).catch((err: Error) => onFail(err.message))}
            >
              Read
            </button>
          </div>
          {about && (
            <dl className="fields">
              <div className="field">
                <dt>Device</dt>
                <dd>{about.deviceName || "—"}</dd>
              </div>
              <div className="field">
                <dt>Serial</dt>
                <dd>{about.serialNumber || "—"}</dd>
              </div>
              <div className="field">
                <dt>Firmware</dt>
                <dd>{about.revision || "—"}</dd>
              </div>
            </dl>
          )}
        </Card>
        {state.mock && (
          <Card title="Mock reader" aside="No hardware">
            <div className="doorsim">
              <span className="doorsim-label">Card {state.mockInserted ? "in slot" : "out"}</span>
              <button disabled={!open} onClick={() => guard(api.sankyo.simulateCard(!state.mockInserted))}>
                {state.mockInserted ? "Remove card" : "Insert card"}
              </button>
            </div>
          </Card>
        )}
        {aside}
      </div>
    </>
  );
}

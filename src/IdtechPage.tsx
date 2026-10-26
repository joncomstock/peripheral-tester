import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { BaseState, CardData, ReadResult } from "./api.ts";
import * as api from "./api.ts";
import { CardPanel, Verdict } from "./CardReaderPage.tsx";
import { Card } from "./ui.tsx";

export interface IdtechState extends BaseState {
  /** The slot switches, as the reader last reported them. Null until it has. */
  slot: { present: boolean; seated: boolean } | null;
  /** A read is waiting for the next card. */
  reading: boolean;
  listening: boolean;
  /** A listened-for card is held server-side until collected. The stream never carries the card. */
  cardWaiting: boolean;
  /** How long a read waits. */
  seconds: number;
}

const slotText = (slot: IdtechState["slot"]) => !slot ? "Slot unknown" : slot.seated ? "Card seated" : slot.present ? "Card in slot" : "Slot empty";

/**
 * The ID TECH insert reader's screen. The reader reads a card as it is withdrawn and reports it
 * unasked, so "Read once" waits for the next card and "Listen" keeps each one for collection.
 */
export function IdtechPage(
  { state, onFail, aside }: { state: IdtechState; onFail: (message: string) => void; aside: ReactNode },
) {
  const [card, setCard] = useState<CardData | null>(null);
  const [outcome, setOutcome] = useState<ReadResult["kind"] | null>(null);
  const [reveal, setReveal] = useState(false);
  const [about, setAbout] = useState<{ version: string; serialNumber: string; status: string } | null>(null);
  const open = state.status === "open";
  const idtech = api.device("idtech");
  const guard = (work: Promise<unknown>) => work.catch((err: Error) => onFail(err.message));

  const read = () => {
    setCard(null);
    setOutcome(null);
    // Every read starts masked. Revealing is a deliberate act, not a state that persists.
    setReveal(false);
    idtech.act<ReadResult>("read")
      .then((result) => {
        setOutcome(result.kind ?? null);
        setCard(result.card ?? null);
      })
      .catch((err: Error) => onFail(err.message));
  };

  // A listening session leaves the card server-side and only flags that one is there. Collect it as
  // soon as that flag appears: the fetch is single-shot, so nothing accumulates anywhere.
  useEffect(() => {
    if (!state.cardWaiting) return;
    let live = true;
    api.device("idtech").act<{ ok: boolean; card: CardData | null }>("take-card")
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
        <Card title="Read a card" aside={open ? slotText(state.slot) : undefined} grow={4}>
          <div className="readpane">
            <div className="readpane-actions">
              <button className="primary" onClick={read} disabled={!open || state.reading || state.listening}>
                {state.reading ? "Waiting for a card…" : `Read once · ${state.seconds}s`}
              </button>
              {state.listening
                ? <button onClick={() => guard(idtech.act("stop"))} disabled={!open}>Stop listening</button>
                : <button onClick={() => guard(idtech.act("listen"))} disabled={!open || state.reading}>Listen</button>}
              <button onClick={() => guard(idtech.act("cancel"))} disabled={!open || !state.reading}>Cancel</button>
            </div>

            {card
              ? <CardPanel card={card} reveal={reveal} onReveal={() => setReveal((was) => !was)} />
              : <Verdict outcome={outcome} busy={state.reading} open={open} />}
          </div>
        </Card>
      </div>

      <div className="col col-narrow">
        <Card title="Device" aside={about ? undefined : "Not read"}>
          <div className="doorsim">
            <span className="doorsim-label">Identity</span>
            <button
              disabled={!open}
              onClick={() =>
                idtech.act<{ version: string; serialNumber: string; status: string }>("identity")
                  .then(({ version, serialNumber, status }) => setAbout({ version, serialNumber, status }))
                  .catch((err: Error) => onFail(err.message))}
            >
              Read
            </button>
          </div>
          {about && (
            <dl className="fields">
              <div className="field">
                <dt>Version</dt>
                <dd>{about.version || "—"}</dd>
              </div>
              <div className="field">
                <dt>Serial</dt>
                <dd>{about.serialNumber || "—"}</dd>
              </div>
              <div className="field">
                <dt>Status</dt>
                <dd>{about.status || "—"}</dd>
              </div>
            </dl>
          )}
        </Card>
        {state.mock && (
          <Card title="Mock reader" aside="No hardware">
            <div className="doorsim">
              <span className="doorsim-label">Dip a card</span>
              <button disabled={!open} onClick={() => guard(idtech.act("simulate", { card: "card" }))}>Test card</button>
              <button disabled={!open} onClick={() => guard(idtech.act("simulate", { card: "unreadable" }))}>Unreadable</button>
            </div>
          </Card>
        )}
        {aside}
      </div>
    </>
  );
}

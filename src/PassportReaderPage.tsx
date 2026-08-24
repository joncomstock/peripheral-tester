import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ImageRegion,
  LightSource,
  MrzCheck,
  MrzRead,
  NextScan,
  OcrSource,
  PassportReaderState,
  ScanResolution,
  WireBarcode,
} from "./api.ts";
import * as api from "./api.ts";
import { badgeClass, glyph, LAMP, lampColor, lampStyle, segStyle } from "./look.ts";
import type { Tone } from "./look.ts";
import { clockTime, usbId } from "./format.ts";
import { Card, DeviceBar, Row, Stepper } from "./ui.tsx";

/**
 * Operator-facing names for the driver's identifiers.
 *
 * The only thing this page keeps its own copy of, and the light board's screen takes the same
 * exception for the same reason. A source the driver grows and this has not been named falls back
 * to the identifier, so it *appears* rather than disappearing — which is the failure that let
 * `uv3led` go missing when the list itself lived here.
 */
const LIGHT_LABELS: Partial<Record<LightSource, string>> = {
  ir: "Infrared",
  visible: "Visible",
  uv: "Ultraviolet",
  uv3led: "UV + visible",
};

/** The same names, shortened for the image picker, where three sit in one segmented control. */
const LIGHT_SHORT: Partial<Record<LightSource, string>> = {
  ir: "IR",
  visible: "Visible",
  uv: "UV",
  uv3led: "UV+W",
};

const RESOLUTION_LABELS: Partial<Record<ScanResolution, string>> = {
  low: "Low",
  default: "Default",
  high: "High",
};

/** Which capability each source needs. Both ultraviolet sources use the one lamp. */
const LIGHT_NEEDS: Partial<Record<LightSource, string>> = { uv: "uvLight", uv3led: "uvLight" };

/** The capability flags the device reports, in the order a tester reads them. */
const CAPABILITY_LABELS: Record<string, string> = {
  uvLight: "UV light",
  color: "Colour",
  barcode: "Barcode",
  glareReduction: "Glare reduction",
  externalStatusLed: "Ext. LED",
  realTimeClock: "RTC",
  msr: "MSR",
  textDisplay: "Text display",
  graphicalDisplay: "Graphical display",
  externalBuzzer: "Ext. buzzer",
  batteryChargeLevel: "Battery level",
};

const ARM_LABELS: Record<NextScan, string> = {
  passport: "Passport",
  smudged: "Smudged MRZ",
  noDocument: "No MRZ",
  barcodeOnly: "Boarding pass",
};

export interface LightChoice {
  value: LightSource;
  label: string;
}

/**
 * The sources this unit can actually be asked for: what the driver offers, less what it lacks.
 *
 * A unit without the UV lamp reports so, and the controls for both ultraviolet sources are then not
 * offered — an operator pressing a button that cannot do anything learns nothing about the kiosk.
 */
export function lightsFor(sources: readonly LightSource[], capabilities: Record<string, boolean>): LightChoice[] {
  return sources
    .filter((value) => {
      const needs = LIGHT_NEEDS[value];
      return needs === undefined || capabilities[needs] === true;
    })
    .map((value) => ({ value, label: LIGHT_LABELS[value] ?? value }));
}

/** Everything but the last two characters, hidden. */
function mask(value: string): string {
  if (value.length <= 2) return value;
  return "•".repeat(value.length - 2) + value.slice(-2);
}

export function PassportReaderPage(
  { state, onFail, toast }: {
    state: PassportReaderState;
    onFail: (message: string) => void;
    toast: (text: string, tone?: Tone) => void;
  },
) {
  const [mrz, setMrz] = useState<MrzRead | null>(null);
  const [barcode, setBarcode] = useState<WireBarcode | null>(null);
  const [reveal, setReveal] = useState(false);
  const [showFields, setShowFields] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  /** Which presentation this is, so a repeat read of the same document is visibly a new one. */
  const [presentation, setPresentation] = useState(0);
  /**
   * Whether the next granular read opens a new presentation.
   *
   * A presentation is one document on the glass, not one API call: `Read MRZ` followed by `Read
   * barcode` is two calls describing the same passport, and numbering them separately left the
   * MRZ from "presentation 1" sitting under a heading that said 2. Set again by anything that
   * means the material has changed — clearing the results, or a fresh scan.
   */
  const fresh = useRef(true);
  /** When the last call landed and how long the driver took, as the backend measured it. */
  const [took, setTook] = useState<{ at: string; ms: number } | null>(null);
  /** Bumped by Retrieve: identifies which encode the image endpoint should be asked for. */
  const [imageNonce, setImageNonce] = useState(0);
  const [imageLight, setImageLight] = useState<LightSource>("visible");
  const [imageRegion, setImageRegion] = useState<ImageRegion>("document");

  const open = state.status === "open";
  const opening = state.status === "opening";
  const capabilities = state.device?.capabilities ?? {};
  const settings = state.settings;
  const guard = (work: Promise<unknown>) => work.catch((err: Error) => onFail(err.message));

  /**
   * Forget everything read from the document that was on the glass.
   *
   * One function rather than a reset per caller: there were three, differing on which fields each
   * remembered to clear, and the one behind `Scan` forgot the results — so a new exposure left the
   * *previous* document's MRZ on screen with the *new* document's image retrievable beside it.
   */
  const forget = useCallback(() => {
    setMrz(null);
    setBarcode(null);
    setReveal(false);
    setImageNonce(0);
    setTook(null);
    fresh.current = true;
  }, []);

  // A closed scanner holds nothing, and a reconnected one starts from an empty window.
  useEffect(() => {
    if (open) return;
    setWaiting(false);
    setPresentation(0);
    forget();
  }, [open, forget]);

  /**
   * "Wait for document" arms the presence poll the backend is already running, rather than starting
   * a second one.
   *
   * The driver's own `waitForDocument` is `isDocumentPresent` in a loop, and the backend polls that
   * from the moment it connects so the page can show presence live. A second loop would contend
   * with the first for the driver's API lock and answer the same question twice.
   */
  useEffect(() => {
    if (!waiting || state.documentPresent !== true) return;
    setWaiting(false);
    toast("Document on the glass", "ok");
  }, [waiting, state.documentPresent, toast]);

  /**
   * How long the driver took, and when.
   *
   * The duration is the backend's measurement of the driver call, not a round trip: a full-page
   * scan is a USB transfer plus an OCR pass, and folding loopback HTTP into that would make a fast
   * device look slow. The clock is this machine's, which is the same machine.
   */
  const stamp = (ms: number) =>
    // Accumulated, not replaced: two granular reads of one document took the sum of their times,
    // and showing only the second made a slow OCR pass look instant because a barcode read followed.
    setTook((previous) => ({ at: clockTime(), ms: (previous?.ms ?? 0) + ms }));

  /**
   * Open a presentation, or join the one already open.
   *
   * `Read document` forces a new one because it rescans; the granular reads join, so their results
   * accumulate into one description of one document.
   */
  const begin = (force: boolean) => {
    if (!force && !fresh.current) return;
    forget();
    fresh.current = false;
    setPresentation((n) => n + 1);
  };

  /**
   * Every call that asks the device for something.
   *
   * Masking is restored here rather than in `forget()`, because `forget()` only runs when a *new*
   * presentation opens — and `Read MRZ` joins the open one. With `ReadOcrDevice`, which needs no
   * scan, that let a newly presented document's number and date of birth render unmasked under
   * the previous presentation. README: revealing is deliberate, and resets on the next read.
   */
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setWaiting(false);
    setReveal(false);
    try {
      await work();
    }
    catch (err) {
      onFail((err as Error).message);
    }
    finally {
      setBusy(false);
    }
  };

  /** Scan, MRZ and barcode under one driver lock, so the recognition is of the scan beside it. */
  const readDocument = () =>
    run(async () => {
      begin(true);
      const result = await api.passportreader.read();
      setMrz(result.mrz ?? null);
      setBarcode(result.barcode ?? null);
      stamp(result.ms);
    });

  /**
   * Expose the document, which is what opens a presentation.
   *
   * A presentation is one document: the exposure is its first act, and the granular reads that
   * follow describe the same one and accumulate onto it. Stamping the scan's time without opening
   * anything billed it to the presentation just closed, where the next read then discarded it.
   */
  const scan = () =>
    run(async () => {
      const result = await api.passportreader.scan();
      begin(true);
      stamp(result.ms);
    });

  const readMrz = () =>
    run(async () => {
      begin(false);
      const result = await api.passportreader.mrz();
      setMrz(result.mrz);
      stamp(result.ms);
    });

  const readBarcode = () =>
    run(async () => {
      begin(false);
      const result = await api.passportreader.barcode();
      setBarcode(result.barcode);
      stamp(result.ms);
    });

  const clear = () => {
    // The number is kept. It exists so a second read of the same document is visibly a second
    // read, and restarting it at one is exactly the confusion it was added to prevent.
    forget();
    toast("Results cleared — device state untouched", "warn");
  };

  const toggle = () => {
    if (open) api.passportreader.disconnect().catch((err: Error) => onFail(err.message));
    else if (!opening) api.passportreader.connect().catch(() => {});
  };

  /**
   * Infrared is required only while the OCR runs on the PC.
   *
   * `ReadOcrPc` reads the infrared image of the held scan, so dropping it there arms a read that
   * cannot recognise anything. `ReadOcrDevice` needs no scan at all, and refusing to turn infrared
   * off in that mode made half of the source choice untestable.
   */
  const irRequired = settings.source === "pc";

  /**
   * Whether `Read MRZ` can produce anything.
   *
   * `ReadOcrPc` reads the held infrared scan, and against nothing held it returns whatever the API
   * still has — the previous document. The backend refuses it; the button is disabled here so the
   * refusal is not the way anyone finds out. `ReadOcrDevice` needs no scan.
   */
  const mrzReadable = settings.source === "device" || state.scanned;

  const toggleLight = (light: LightSource) => {
    const has = settings.lights.includes(light);
    const next = has ? settings.lights.filter((each) => each !== light) : [...settings.lights, light];
    if (next.length === 0) {
      toast("At least one light source must stay on — a scan with none exposes nothing", "warn");
      return;
    }
    if (irRequired && !next.includes("ir")) {
      toast("Infrared must stay on while the OCR runs on the PC — it is the image it reads", "warn");
      return;
    }
    guard(api.passportreader.settings({ lights: next }));
  };

  /**
   * Choosing a light or a region puts the frame back to "Retrieve".
   *
   * Without this the `<img>` src changed the moment a button was pressed and the browser fetched
   * on its own — encoding a full page nobody asked for, and going round `retrieve()`'s two guards,
   * so picking a light the scan never exposed failed as a broken image instead of saying so.
   */
  const pickImage = (choose: () => void) => {
    setImageNonce(0);
    choose();
  };

  const retrieve = () => {
    if (!state.scanned) {
      onFail("No scan is held — the image accessors encode the last scan");
      return;
    }
    if (!settings.lights.includes(imageLight)) {
      onFail(`${LIGHT_LABELS[imageLight] ?? imageLight} was not enabled for that scan — there is no image to encode`);
      return;
    }
    setImageNonce((n) => n + 1);
  };

  const availableLights = lightsFor(state.vocabulary.lights, capabilities);
  const hasResult = mrz !== null || barcode !== null;
  /**
   * Whether the presentation card carries a number.
   *
   * Both halves are needed. Nothing to show means the number would be the one just cleared, and a
   * scan the backend is still holding from before a reload belongs to no presentation this page
   * has opened — which is how the card came to read "Presentation 0".
   */
  const numbered = presentation > 0 && (hasResult || state.scanned);

  return (
    <>
      <DeviceBar
        label="USB FFI"
        address={
          <span className="addressbox-value">
            {/* An em dash, not a half-invented pair: the ids are only known once the DLL has opened
                a unit, which is what `busLine()` says in the rail as well. */}
            {state.mock
              ? "mock"
              : state.device
              ? `${usbId(state.device.vendorId)}:${usbId(state.device.productId)}`
              : "—"}
          </span>
        }
        meta="PageScanAPI"
        status={state.status}
        open={state.device ? `Connected · ${state.device.deviceType}` : "Connected"}
        opening="Opening scanner"
        shut="Not connected"
        hint="Connect to load PageScanAPI.dll and enable the read calls"
      >
        <button
          className="button"
          disabled={!open || busy}
          onClick={() =>
            api.passportreader.reset()
              .then(() => toast("Device reset — connection kept, scan settings re-applied", "warn"))
              .catch((err: Error) => onFail(err.message))}
        >
          Reset
        </button>
        <button className={open ? "button button--strong" : "button button--primary"} onClick={toggle} disabled={opening}>
          {open ? "Disconnect" : opening ? "Opening…" : "Connect"}
        </button>
      </DeviceBar>

      <main className="pane">
        <div className="col col-wide">
          <Card
            title="Read control"
            aside={<code>{settings.lights.join("+")} @ {settings.resolution}</code>}
            quiet
          >
            <Phase state={state} waiting={waiting} busy={busy} />

            <div className="actions">
              <button className="button button--primary" onClick={readDocument} disabled={!open || busy}>Read document</button>
              <button
                className={waiting ? "button button--strong" : "button"}
                onClick={() => setWaiting((was) => !was)}
                disabled={!open || busy || state.documentPresent === null}
                title={state.documentPresent === null ? "This unit cannot report document presence" : undefined}
              >
                {waiting ? "Stop waiting" : "Wait for document"}
              </button>
              <button className="button" onClick={scan} disabled={!open || busy}>Scan</button>
              <button
                className="button"
                onClick={readMrz}
                disabled={!open || busy || !mrzReadable}
                title={mrzReadable ? undefined : "ReadOcrPc reads the held infrared scan — scan first, or move the OCR to the device"}
              >
                Read MRZ
              </button>
              <button className="button" onClick={readBarcode} disabled={!open || busy}>Read barcode</button>
              {/* Enabled for anything on screen, not only a recognised result: after a bare Scan
                  there is still a retrieved image and a duration, and this is what clears them. */}
              <button className="button" onClick={clear} disabled={!hasResult && imageNonce === 0 && took === null}>
                Clear results
              </button>
            </div>

            {state.mock && (
              <div className="simrow">
                <span className="simrow-label">Simulate · next scan</span>
                {(Object.keys(ARM_LABELS) as NextScan[]).map((next) => (
                  <button
                    key={next}
                    className="button button--small"
                    disabled={!open}
                    onClick={() => guard(api.passportreader.arm(next))}
                  >
                    {ARM_LABELS[next]}
                  </button>
                ))}
              </div>
            )}
          </Card>

          <Card
            key={presentation}
            title={numbered ? `Presentation ${presentation}` : "Presentation"}
            aside={took ? `${took.at} · ${took.ms} ms` : "Nothing read yet"}
            action={hasResult
              ? (
                <button className="pill card-head-action" onClick={() => setReveal((was) => !was)}>
                  {reveal ? "Mask" : "Reveal"}
                </button>
              )
              : undefined}
          >
            {hasResult || state.scanned
              ? (
                <>
                  <Arrival
                    mrz={mrz}
                    barcode={barcode}
                    reveal={reveal}
                    scanned={state.scanned}
                    imageNonce={imageNonce}
                    imageLight={imageLight}
                    imageRegion={imageRegion}
                    onFail={onFail}
                  />

                  <div className="imagebar">
                    <span className="setting-label">Image</span>
                    <div className="seg seg--small" data-enabled={open}>
                      {availableLights.map((light) => (
                        <button
                          key={light.value}
                          className="chooser"
                          style={segStyle({ active: imageLight === light.value, enabled: open })}
                          disabled={!open}
                          onClick={() => pickImage(() => setImageLight(light.value))}
                        >
                          {LIGHT_SHORT[light.value] ?? light.label}
                        </button>
                      ))}
                    </div>
                    <div className="seg seg--small" data-enabled={open}>
                      {([["document", "Cropped"], ["full", "Full"]] as const).map(([region, label]) => (
                        <button
                          key={region}
                          className="chooser"
                          style={segStyle({ active: imageRegion === region, enabled: open })}
                          disabled={!open}
                          onClick={() => pickImage(() => setImageRegion(region))}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {/* `busy` as well as `open`: mid-scan, `scanned` still describes the exposure
                        being replaced, so this would encode the new document beside the old MRZ. */}
                    <button className="button button--small" disabled={!open || busy} onClick={retrieve}>Retrieve</button>
                  </div>

                  {mrz && <MrzPanel mrz={mrz} reveal={reveal} showFields={showFields} />}
                  {barcode && <BarcodeRow barcode={barcode} />}
                  <div className="actions">
                    <button className="button button--primary" onClick={readDocument} disabled={!open || busy}>Read again</button>
                    <button className="button" onClick={() => setShowFields((was) => !was)} disabled={!mrz?.fields}>
                      {showFields ? "Hide field list" : "Full field list"}
                    </button>
                  </div>

                  {hasResult && (
                    <p className="masknote">
                      An MRZ is personal data — a name, a nationality, a date of birth and a document
                      number. It exists only in the reply to the read that produced it: nothing here
                      is logged, stored, or written to disk, and masking is display only.
                    </p>
                  )}
                </>
              )
              : <Empty open={open} busy={busy} />}
          </Card>

          <Card title="Scan settings" aside="Applied on the next scan" quiet>
            <Row label="Light sources">
              <div className="seg" data-enabled={open}>
                {availableLights.map((light) => (
                  <button
                    key={light.value}
                    className="chooser"
                    style={segStyle({
                      active: settings.lights.includes(light.value),
                      enabled: open && !(irRequired && light.value === "ir"),
                      tint: light.value.startsWith("uv") ? LAMP.blue : undefined,
                    })}
                    disabled={!open || (irRequired && light.value === "ir")}
                    title={irRequired && light.value === "ir" ? "Infrared is the image ReadOcrPc reads" : undefined}
                    onClick={() => toggleLight(light.value)}
                  >
                    {light.label}
                  </button>
                ))}
              </div>
            </Row>

            <Row label="Resolution">
              <div className="seg" data-enabled={open}>
                {state.vocabulary.resolutions.map((value) => (
                  <button
                    key={value}
                    className="chooser"
                    style={segStyle({ active: settings.resolution === value, enabled: open })}
                    disabled={!open}
                    onClick={() => guard(api.passportreader.settings({ resolution: value }))}
                  >
                    {RESOLUTION_LABELS[value] ?? value}
                  </button>
                ))}
              </div>
            </Row>

            <Row label="Ambient light elimination">
              <div className="seg" data-enabled={open}>
                {([[true, "On"], [false, "Off"]] as const).map(([on, label]) => (
                  <button
                    key={label}
                    className="chooser"
                    style={segStyle({ active: settings.ambientLightElimination === on, off: !on, enabled: open })}
                    disabled={!open}
                    onClick={() => guard(api.passportreader.settings({ ambientLightElimination: on }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Row>

            <Row label="OCR runs on" chip={settings.source === "pc" ? "ReadOcrPc" : "ReadOcrDevice"}>
              <div className="seg" data-enabled={open}>
                {([["pc", "PC"], ["device", "Device"]] as const).map(([source, label]) => (
                  <button
                    key={source}
                    className="chooser"
                    style={segStyle({ active: settings.source === source, enabled: open })}
                    disabled={!open}
                    onClick={() => guard(api.passportreader.settings({ source: source as OcrSource }))}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Row>
          </Card>
        </div>

        <div className="col col-narrow">
          <Card
            title="Device"
            quiet
            action={
              <span
                className={`${badgeClass(!open ? "neutral" : state.device?.deviceType === "gen4" ? "ok" : "warn")} card-head-action`}
              >
                {open ? (state.device?.deviceType ?? "unknown") : "Offline"}
              </span>
            }
          >
            <div className="fieldlist">
              {[
                { label: "Device type", value: state.device?.deviceType },
                {
                  label: "VID:PID",
                  value: state.device ? `${usbId(state.device.vendorId)}:${usbId(state.device.productId)}` : undefined,
                },
                { label: "Firmware", value: state.device?.firmware },
                { label: "FullPage API", value: state.api ? `${state.api.version}.${state.api.number}` : undefined },
                { label: "PageScanAPI.dll", value: state.api?.dllVersion ?? (open ? undefined : "not loaded") },
              ].map(({ label, value }) => (
                <div className="fieldrow" key={label}>
                  <span className="fieldrow-label">{label}</span>
                  {/* `||`, not `??`: the mock's API info comes back as empty strings, which are
                      present but say nothing — an em dash is the honest rendering of both. */}
                  <span className="fieldrow-value mono">{value || "—"}</span>
                </div>
              ))}
            </div>

            <div className="caps">
              <span className="setting-label">Capabilities · GetSystemInfoFlags</span>
              <div className="caps-row">
                {Object.entries(capabilities).length === 0
                  ? <span className="empty-note">Reported once the device is open.</span>
                  : Object.entries(capabilities).map(([flag, fitted]) => (
                    <span key={flag} className={fitted ? "cap cap--on" : "cap"}>
                      {CAPABILITY_LABELS[flag] ?? flag}
                    </span>
                  ))}
              </div>
            </div>
          </Card>

          <Card title="Status LED & buzzer" quiet>
            <div className="lamprow">
              <span
                style={lampStyle(
                  lampColor(state.led),
                  state.led === "off" || !open ? "off" : state.ledUsage === "flashing" ? "blink" : "on",
                  30,
                )}
              />
              {/*
                * A wrapping picker rather than one segmented control: the unit reports seven
                * colours and seven touch-sized segments do not fit the column. The list is the
                * driver's, served with the lights and resolutions, so a colour the vendor adds
                * appears here without this file being edited.
                */}
              <div className="picker">
                {state.vocabulary.ledColors.map((color) => (
                  <button
                    key={color}
                    className="picker-item"
                    style={segStyle({ active: state.led === color, enabled: open, tint: lampColor(color) })}
                    disabled={!open}
                    onClick={() => guard(api.passportreader.led(color))}
                  >
                    {color[0].toUpperCase() + color.slice(1)}
                  </button>
                ))}
                <button
                  className="picker-item"
                  style={segStyle({ active: state.led === "off", off: true, enabled: open })}
                  disabled={!open}
                  onClick={() => guard(api.passportreader.led("off"))}
                >
                  Off
                </button>
              </div>
            </div>

            <Row label="Usage">
              <div className="seg" data-enabled={open}>
                {([["permanent", "Permanent"], ["flashing", "Flashing"]] as const).map(([usage, label]) => (
                  <button
                    key={usage}
                    className="chooser"
                    style={segStyle({ active: state.ledUsage === usage, enabled: open })}
                    disabled={!open}
                    onClick={() => guard(api.passportreader.led(state.led, usage))}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Row>

            <Row label="Buzzer">
              {/* Changing the number is a setting; sounding it is the button beside it. */}
              <Stepper
                value={`${state.buzzerMs} ms`}
                enabled={open}
                less="shorter"
                more="longer"
                onLess={() => guard(api.passportreader.settings({ buzzerMs: state.buzzerMs - 100 }))}
                onMore={() => guard(api.passportreader.settings({ buzzerMs: state.buzzerMs + 100 }))}
              />
              <button className="button button--small" disabled={!open} onClick={() => guard(api.passportreader.buzz())}>
                Sound
              </button>
            </Row>
          </Card>
        </div>
      </main>
    </>
  );
}

/** Where the device is in a read, in one line. */
function Phase({ state, waiting, busy }: { state: PassportReaderState; waiting: boolean; busy: boolean }) {
  const open = state.status === "open";
  const present = state.documentPresent;
  const label = !open
    ? "Not connected"
    : busy
    ? "Reading"
    : waiting
    ? "Waiting for a document"
    : present === null
    ? "Presence unavailable"
    : present
    ? "Document on the glass"
    : "Glass empty";
  const note = !open
    ? ""
    : waiting
    ? "Watching the device's presence poll"
    : present === null
    ? "This unit does not answer IsDocumentPresent"
    : state.scanned
    ? "Scan held — ready to read"
    : "No scan held";

  return (
    <div className={waiting || busy ? "phase phase--active" : "phase"}>
      <span
        style={lampStyle(
          waiting || busy ? LAMP.amber : LAMP.green,
          waiting || busy ? "blink" : open && present ? "on" : "off",
          14,
        )}
      />
      <span className="phase-label">{label}</span>
      <span className="phase-note">{note}</span>
    </div>
  );
}

/** What is on screen before a read has produced anything. */
function Empty({ open, busy }: { open: boolean; busy: boolean }) {
  const [title, note] = !open
    ? ["Scanner not connected", "Connect to load PageScanAPI.dll, then place a document on the window."]
    : busy
    ? ["Reading", "Hold the document flat against the stop."]
    // No `scanned` arm: a held scan routes to the presentation card, which says so there.
    : [
      "No presentation yet",
      "Place a document, then Read document — scan, MRZ and barcode under one lock. The granular calls stay available beside it.",
    ];

  return (
    <div className="empty">
      <span className="empty-title">{title}</span>
      <span className="empty-note">{note}</span>
    </div>
  );
}

/**
 * The headline of a presentation: what arrived, who it says they are, and the scanned page.
 *
 * The image is fetched only when Retrieve is pressed. Encoding a full page is a USB transfer plus
 * a compress, and the picture is somebody's passport — neither is worth doing on the chance that
 * someone wants to look.
 */
function Arrival(
  { mrz, barcode, reveal, scanned, imageNonce, imageLight, imageRegion, onFail }: {
    mrz: MrzRead | null;
    barcode: WireBarcode | null;
    reveal: boolean;
    scanned: boolean;
    imageNonce: number;
    imageLight: LightSource;
    imageRegion: ImageRegion;
    onFail: (message: string) => void;
  },
) {
  const fields = mrz?.fields;
  const checks = fields ? Object.values(fields.checks).filter(Boolean) : [];
  const valid = checks.filter((check) => (check as MrzCheck).valid).length;
  const number = fields?.documentNumber ?? "";
  const expiry = fields?.dateOfExpiry.iso ?? fields?.dateOfExpiry.raw;

  const badges: { tone: Tone; text: string }[] = [];
  if (mrz?.recognized) badges.push({ tone: "ok", text: `MRZ · ${fields?.format ?? "unrecognised layout"}` });
  else if (mrz) badges.push({ tone: "warn", text: "MRZ · not recognised" });
  if (barcode?.found) badges.push({ tone: "ok", text: `Barcode · ${barcode.symbology}` });
  else if (barcode) badges.push({ tone: "neutral", text: "Barcode · none" });
  if (mrz?.hasUnclassifiedCharacters) badges.push({ tone: "warn", text: "Unclassified characters" });

  return (
    <div className="arrival">
      <div className="scanframe">
        {imageNonce > 0
          ? (
            <img
              className="scanframe-image"
              src={api.passportreader.imageUrl(imageLight, imageRegion, imageNonce)}
              alt={`document scanned under ${imageLight} light`}
              onError={() => onFail(`No ${imageLight} image for the held scan — was that light enabled?`)}
            />
          )
          : <span className="scanframe-note">{scanned ? "Retrieve to encode the held scan" : "No scan held"}</span>}
      </div>

      {mrz === null && barcode === null
        ? (
          <span className="empty-note">
            A scan is held. Retrieve encodes it under the light and region below, or Read MRZ / Read
            barcode interprets it.
          </span>
        )
        : (
          <div className="arrival-body">
            <div className="badges">
              {badges.map((badge) => (
                <span key={badge.text} className={badgeClass(badge.tone)}>{glyph(badge.tone)}{badge.text}</span>
              ))}
            </div>

            <div className="headline-field">
              <span className="setting-label">Holder</span>
              <span className="headline-value">
                {fields ? [fields.givenNames, fields.surname].filter(Boolean).join(" ") : "—"}
              </span>
            </div>

            <div className="headline">
              <div className="headline-field">
                <span className="setting-label">Document</span>
                <span className="headline-value mono">{number ? (reveal ? number : mask(number)) : "—"}</span>
              </div>
              <div className="headline-field">
                <span className="setting-label">Expiry</span>
                <span className="headline-value mono">{expiry ?? "—"}</span>
              </div>
              <div className="headline-field">
                <span className="setting-label">Checks</span>
                <span className={fields?.allChecksValid ? "headline-value tone-ok" : "headline-value tone-bad"}>
                  {checks.length === 0 ? "—" : `${valid} of ${checks.length} valid`}
                </span>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}

/**
 * An MRZ that was read.
 *
 * The document number and date of birth are masked unless asked, and so are the raw lines, which
 * carry both inline — the same policy the card reader applies to a PAN. Nothing here is logged or
 * stored.
 */
function MrzPanel({ mrz, reveal, showFields }: { mrz: MrzRead; reveal: boolean; showFields: boolean }) {
  const fields = mrz.fields;
  if (!mrz.recognized) {
    return (
      <div className="empty">
        <span className="empty-title">No machine-readable zone</span>
        <span className="empty-note">
          The engine answered rrFailed. The page may have moved during the scan, or the document may
          not carry one — a boarding pass carries its data in the barcode instead.
        </span>
      </div>
    );
  }

  // The lines carry the number and the birth date inline, so they are blanked there too.
  const lines = reveal ? mrz.lines : mrz.lines.map((line) => maskMrzLine(line, fields));

  return (
    <>
      <div className="mrz">
        {lines.map((line, index) => <div className="mrz-line" key={index}>{line}</div>)}
      </div>

      {showFields && fields && (
        <div className="fieldlist">
          {[
            { label: "Document code", value: fields.documentCode, mono: true },
            { label: "Issuing state", value: fields.issuingState, mono: true },
            { label: "Surname", value: fields.surname },
            { label: "Given names", value: fields.givenNames },
            { label: "Document number", value: reveal ? fields.documentNumber : mask(fields.documentNumber), mono: true, check: fields.checks.documentNumber },
            { label: "Nationality", value: fields.nationality, mono: true },
            {
              label: "Date of birth",
              value: reveal ? (fields.dateOfBirth.iso ?? fields.dateOfBirth.raw) : mask(fields.dateOfBirth.iso ?? fields.dateOfBirth.raw),
              mono: true,
              check: fields.checks.dateOfBirth,
            },
            { label: "Sex", value: fields.sex, mono: true },
            {
              label: "Date of expiry",
              value: fields.dateOfExpiry.iso ?? fields.dateOfExpiry.raw,
              mono: true,
              check: fields.checks.dateOfExpiry,
            },
            { label: "Optional data", value: fields.optionalData, mono: true, check: fields.checks.optionalData },
            { label: "Composite", value: "over the whole second line", check: fields.checks.composite },
            { label: "Recognition source", value: mrz.source === "pc" ? "PC · ReadOcrPc" : "Device · ReadOcrDevice" },
          ].map(({ label, value, mono, check }) => (
            <div className="fieldrow" key={label}>
              <span className="fieldrow-label">{label}</span>
              <span className={mono ? "fieldrow-value mono" : "fieldrow-value"}>{value || "—"}</span>
              {check && (
                <span className={badgeClass(check.valid ? "ok" : "bad")}>
                  {check.digit} {check.valid ? "✓" : "✗"}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function BarcodeRow({ barcode }: { barcode: WireBarcode }) {
  if (!barcode.found) {
    return (
      <div className="fieldrow">
        <span className="fieldrow-label">Barcode</span>
        <span className="fieldrow-value">
          ReadBarcode answered found:false — the device decodes as documents pass the window, and
          nothing has been decoded since the last read.
        </span>
      </div>
    );
  }
  return (
    <div className="fieldrow">
      <span className="fieldrow-label">Barcode {barcode.symbologyCode} · {barcode.symbology}</span>
      <span className="fieldrow-value mono">{barcode.text}</span>
      <span className="chip">{barcode.byteLength} bytes</span>
      {/* Only present for a payload that is not printable, where the text above is not readable. */}
      {barcode.hex && <span className="fieldrow-value mono tone-muted">{barcode.hex}</span>}
    </div>
  );
}

/**
 * One MRZ line with its personal data blanked.
 *
 * With a parsed layout the document number and the date of birth are known strings, so only those
 * are blanked and the rest of the zone stays readable — which is the point of showing it.
 *
 * **Without one, everything goes.** The driver reports `recognized: true` whenever the engine
 * returned a good read, but `parseMrz` returns `undefined` for any line lengths that are not
 * 3×30, 2×44 or 2×36 — a short or garbled OCR pass, which is precisely the fault this screen
 * exists to surface. Blanking "the known secrets" then blanks nothing, because none are known, and
 * the whole zone printed unmasked with the Mask button unable to touch it. Mock mode cannot reach
 * that state: both of its specimens are 2×44 and always parse.
 *
 * The `<` fillers survive either way. They carry nothing, and the shape they leave is exactly what
 * tells someone whether the OCR came back the right length.
 */
export function maskMrzLine(line: string, fields: MrzRead["fields"]): string {
  if (!fields) return line.replaceAll(/[^<]/g, "•");
  let out = line;
  for (const secret of [fields.documentNumber, fields.dateOfBirth.raw]) {
    if (secret && secret.length > 2) out = out.replace(asItAppears(secret), "•".repeat(secret.length));
  }
  return out;
}

/**
 * A parsed field, as a pattern matching the characters it was read from.
 *
 * Not string equality. `parseMrz` runs every field through `trimFiller`, which turns an *interior*
 * `<` into a space — so a document number the OCR read as `L8989<2C3` arrives here as `L8989 2C3`
 * and `replaceAll` finds nothing, printing the number in full inside a zone the screen claims is
 * masked. The date of birth is not trimmed and so was never affected, which is why the failure
 * showed as one field blanking and the other not.
 *
 * A single misread glyph keeps the line length, so the layout still parses and the blanket-blank
 * path above does not catch it either. Mock mode cannot produce it: both specimens read cleanly.
 */
function asItAppears(secret: string): RegExp {
  // The space is deliberately not escaped — it is the character that has to become an alternation.
  return new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(" ", "[ <]"), "g");
}

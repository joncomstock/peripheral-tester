import { useState } from "react";
import type { ReactNode } from "react";
import type {
  WireBarcode,
  LightSource,
  MrzCheck,
  MrzRead,
  NextScan,
  PassportReaderState,
  ScanResolution,
  StatusLedColor,
} from "./api.ts";
import * as api from "./api.ts";
import { LAMP, lampStyle } from "./look.ts";
import { usbId } from "./format.ts";
import { Card } from "./ui.tsx";
import { StatusPill } from "./LightBoardPage.tsx";

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

const RESOLUTION_LABELS: Partial<Record<ScanResolution, string>> = {
  low: "Low",
  default: "Default",
  high: "High",
};

/** Which capability each source needs. Both ultraviolet sources use the one lamp. */
const LIGHT_NEEDS: Partial<Record<LightSource, string>> = { uv: "uvLight", uv3led: "uvLight" };

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

/** The status-LED colours offered, chosen as the four the tester already draws lamps for. */
const LED_COLORS = ["green", "yellow", "red", "blue"] as const satisfies readonly StatusLedColor[];

const ARM_LABELS: Record<NextScan, string> = {
  passport: "Passport",
  smudged: "Smudged MRZ",
  noDocument: "No MRZ",
  barcodeOnly: "Boarding pass",
};

/** Everything but the last two characters, hidden. */
function mask(value: string): string {
  if (value.length <= 2) return value;
  return "•".repeat(value.length - 2) + value.slice(-2);
}

export function PassportReaderPage(
  { state, onFail, aside }: { state: PassportReaderState; onFail: (message: string) => void; aside: ReactNode },
) {
  const [mrz, setMrz] = useState<MrzRead | null>(null);
  const [barcode, setBarcode] = useState<WireBarcode | null>(null);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Bumped on every read: identifies which scan the image endpoint should be asked for. */
  const [scan, setScan] = useState(0);
  const [imageLight, setImageLight] = useState<LightSource>("visible");

  const open = state.status === "open";
  const capabilities = state.device?.capabilities ?? {};
  const guard = (work: Promise<unknown>) => work.catch((err: Error) => onFail(err.message));

  const read = async () => {
    setBusy(true);
    setMrz(null);
    setBarcode(null);
    // Every read starts masked. Revealing is a deliberate act, not a state that persists into the
    // next document.
    setReveal(false);
    try {
      const result = await api.passportreader.read();
      setMrz(result.mrz ?? null);
      setBarcode(result.barcode ?? null);
      setScan((n) => n + 1);
      // Show a light that was actually exposed, or the image call has nothing to encode.
      if (!state.settings.lights.includes(imageLight)) setImageLight(state.settings.lights[0]);
    }
    catch (err) {
      onFail((err as Error).message);
    }
    finally {
      setBusy(false);
    }
  };

  const toggleLight = (light: LightSource) => {
    const has = state.settings.lights.includes(light);
    const next = has ? state.settings.lights.filter((l) => l !== light) : [...state.settings.lights, light];
    // Infrared is what the PC-side OCR reads, and one light must stay on for a scan to produce
    // anything at all. Refusing here beats arming a scan that cannot succeed.
    if (next.length === 0 || !next.includes("ir")) return;
    guard(api.passportreader.settings({ lights: next }));
  };

  const availableLights = lightsFor(state.vocabulary.lights, capabilities);

  return (
    <>
      <div className="col col-wide">
        <Card
          title="Read a document"
          aside={state.settings.lights.join(" + ")}
          action={<PresenceLamp present={state.documentPresent} open={open} />}
          grow={4}
        >
          <div className="readpane">
            <div className="readpane-actions">
              <button className="primary" onClick={read} disabled={!open || busy}>
                {busy ? "Scanning…" : "Scan and read"}
              </button>
              <button onClick={() => guard(api.passportreader.buzz())} disabled={!open || busy}>Buzzer</button>
            </div>

            {mrz
              ? <MrzPanel mrz={mrz} reveal={reveal} onReveal={() => setReveal((was) => !was)} />
              : <Verdict busy={busy} open={open} attempted={scan > 0} />}

            {barcode && <BarcodeRow barcode={barcode} />}
          </div>
        </Card>

        <Card title="Scanned page" aside={scan > 0 ? `${imageLight} light` : undefined} grow={3}>
          {scan === 0
            ? <div className="verdict">Scan a document to see the page as the device captured it.</div>
            : (
              <div className="scanshot">
                <div className="seg" data-enabled={open}>
                  {availableLights
                    .filter((light) => state.settings.lights.includes(light.value))
                    .map((light) => (
                      <button
                        key={light.value}
                        className={imageLight === light.value ? "chooser chooser-on" : "chooser"}
                        onClick={() => setImageLight(light.value)}
                      >
                        {light.label}
                      </button>
                    ))}
                </div>
                <img
                  className="scanshot-image"
                  src={api.passportreader.imageUrl(imageLight, scan)}
                  alt={`document scanned under ${imageLight} light`}
                  onError={() => onFail(`No ${imageLight} image for the last scan — was that light enabled?`)}
                />
                <p className="masknote">
                  The scan is the printed page and the portrait with it. It is served to this tab and
                  never written to disk or recorded in the log.
                </p>
              </div>
            )}
        </Card>

        <Card title="Scan settings" aside={state.settings.resolution}>
          <div className="settings">
            <div className="setting">
              <span className="setting-label">Light sources</span>
              <div className="seg" data-enabled={open}>
                {availableLights.map((light) => (
                  <button
                    key={light.value}
                    className={state.settings.lights.includes(light.value) ? "chooser chooser-on" : "chooser"}
                    disabled={!open || light.value === "ir"}
                    title={light.value === "ir" ? "Infrared is what the OCR reads" : undefined}
                    onClick={() => toggleLight(light.value)}
                  >
                    {light.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting">
              <span className="setting-label">Resolution</span>
              <div className="seg" data-enabled={open}>
                {state.vocabulary.resolutions.map((value) => (
                  <button
                    key={value}
                    className={state.settings.resolution === value ? "chooser chooser-on" : "chooser"}
                    disabled={!open}
                    onClick={() => guard(api.passportreader.settings({ resolution: value }))}
                  >
                    {RESOLUTION_LABELS[value] ?? value}
                  </button>
                ))}
              </div>
            </div>

            <div className="setting">
              <span className="setting-label">Status LED</span>
              <div className="seg" data-enabled={open}>
                {LED_COLORS.map((color) => (
                  <button
                    key={color}
                    className={state.led === color ? "chooser chooser-on" : "chooser"}
                    disabled={!open}
                    onClick={() => guard(api.passportreader.led(color))}
                  >
                    <span className="lamp-inline" style={lampStyle(LAMP[color], state.led === color ? "on" : "off", 12)} />
                    {color[0].toUpperCase() + color.slice(1)}
                  </button>
                ))}
                <button
                  className={state.led === "off" ? "chooser chooser-on" : "chooser"}
                  disabled={!open}
                  onClick={() => guard(api.passportreader.led("off"))}
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
          <Card title="Mock scanner" aside="No hardware">
            <div className="doorsim">
              <span className="doorsim-label">Next scan</span>
              {(Object.keys(ARM_LABELS) as NextScan[]).map((next) => (
                <button key={next} disabled={!open} onClick={() => guard(api.passportreader.arm(next))}>
                  {ARM_LABELS[next]}
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

/** Whether a document is on the glass, as the device reports it. */
function PresenceLamp({ present, open }: { present: boolean | null; open: boolean }) {
  if (!open) return null;
  // `null` is the device saying it cannot answer, which is not the same as "no document".
  if (present === null) return <span className="card-aside">presence unavailable</span>;
  return (
    <span className="card-aside">
      <span className="lamp-inline" style={lampStyle(present ? LAMP.green : LAMP.amber, present ? "on" : "off", 12)} />
      {present ? "document on the glass" : "window clear"}
    </span>
  );
}

/** What a scan produced when it produced no MRZ. */
function Verdict({ busy, open, attempted }: { busy: boolean; open: boolean; attempted: boolean }) {
  if (!open) return <div className="verdict">Connect the scanner to read a document.</div>;
  if (busy) return <div className="verdict">Scanning. Hold the document flat against the stop.</div>;
  if (attempted) {
    return (
      <div className="verdict">
        No machine-readable zone was recognised. The page may have moved during the scan, or the
        document may not carry one.
      </div>
    );
  }
  return <div className="verdict">Ready. Place a passport, ID card or boarding pass on the window.</div>;
}

/**
 * An MRZ that was read.
 *
 * The document number and date of birth are masked unless asked, and so are the raw lines, which
 * carry both inline — the same policy the card reader applies to a PAN. Nothing here is logged or
 * stored.
 */
function MrzPanel({ mrz, reveal, onReveal }: { mrz: MrzRead; reveal: boolean; onReveal: () => void }) {
  const f = mrz.fields;
  const number = f?.documentNumber ?? "";
  const shownNumber = reveal ? number : mask(number);
  const born = f?.dateOfBirth.iso ?? f?.dateOfBirth.raw ?? "";
  const shownBorn = reveal ? born : mask(born);
  // The lines carry the number and the birth date inline, so they are blanked there too.
  const shownLines = reveal ? mrz.lines : mrz.lines.map((line) => maskLine(line, [number, f?.dateOfBirth.raw]));

  const rows: { label: string; value?: string }[] = [
    { label: "Layout", value: f?.format ?? "not recognised" },
    { label: "Name", value: f ? [f.surname, f.givenNames].filter(Boolean).join(", ") : undefined },
    { label: "Nationality", value: f?.nationality },
    { label: "Document no.", value: shownNumber || undefined },
    { label: "Date of birth", value: shownBorn || undefined },
    { label: "Expires", value: f?.dateOfExpiry.iso ?? f?.dateOfExpiry.raw },
    { label: "Sex", value: f?.sex },
  ];

  return (
    <div className="cardpanel">
      <div className="cardpanel-head">
        <span style={lampStyle(f?.allChecksValid ? LAMP.green : LAMP.amber, "on", 14)} />
        <span className="cardpanel-title">
          {f?.allChecksValid ? "MRZ read — check digits valid" : f ? "MRZ read — a check digit failed" : "MRZ read — layout not recognised"}
        </span>
        <button className="clear" onClick={onReveal}>{reveal ? "Mask" : "Reveal"}</button>
      </div>

      <dl className="fields">
        {rows.map(({ label, value }) => (
          <div className="field" key={label}>
            <dt>{label}</dt>
            <dd>{value ?? "—"}</dd>
          </div>
        ))}
      </dl>

      {f && <Checks checks={f.checks} />}

      {mrz.hasUnclassifiedCharacters && (
        <div className="verdict verdict-bad">
          The OCR could not classify every glyph. Any check digit covering an unreadable character
          fails, which is why a field below may read as invalid. Reveal the zone to see them — they
          appear as <code>*</code>.
        </div>
      )}

      <div className="rawstripe rawstripe--mrz">
        <span className="setting-label">Machine-readable zone</span>
        <code>{shownLines.join("\n")}</code>
      </div>

      <p className="masknote">
        An MRZ is personal data — a name, a nationality, a date of birth and a document number.
        Masking here is display only, and nothing on this screen is logged or stored.
      </p>
    </div>
  );
}

/** Every check digit the layout carries, and whether it verified. */
function Checks({ checks }: { checks: NonNullable<MrzRead["fields"]>["checks"] }) {
  const entries: { label: string; check?: MrzCheck }[] = [
    { label: "Document no.", check: checks.documentNumber },
    { label: "Birth date", check: checks.dateOfBirth },
    { label: "Expiry", check: checks.dateOfExpiry },
    { label: "Optional data", check: checks.optionalData },
    { label: "Composite", check: checks.composite },
  ];
  return (
    <div className="checks">
      <span className="setting-label">Check digits</span>
      <div className="checks-row">
        {entries.filter((entry) => entry.check !== undefined).map(({ label, check }) => (
          <span key={label} className={check!.valid ? "chip tone-ok" : "chip tone-bad"}>
            {label} {check!.valid ? "✓" : "✗"}
          </span>
        ))}
      </div>
    </div>
  );
}

function BarcodeRow({ barcode }: { barcode: WireBarcode }) {
  if (!barcode.found) return null;
  return (
    <div className="rawstripe">
      <span className="setting-label">Barcode · {barcode.symbology} · {barcode.byteLength} bytes</span>
      <code>{barcode.text}</code>
      {/* Only present for a payload that is not printable, where the text above is not readable. */}
      {barcode.hex && <code className="barcode-hex">{barcode.hex}</code>}
    </div>
  );
}

/** Blank the given values wherever they appear inside an MRZ line. */
function maskLine(line: string, secrets: (string | undefined)[]): string {
  let out = line;
  for (const secret of secrets) {
    if (secret && secret.length > 2) out = out.replaceAll(secret, "•".repeat(secret.length));
  }
  return out;
}

/** The header cluster for this device. */
export function PassportReaderControls(
  { state, onFail }: { state: PassportReaderState; onFail: (message: string) => void },
) {
  const open = state.status === "open";
  const opening = state.status === "opening";

  const toggle = () => {
    if (open) api.passportreader.disconnect().catch((err: Error) => onFail(err.message));
    else if (!opening) api.passportreader.connect().catch(() => {});
  };

  const usb = state.device ? `${usbId(state.device.vendorId)}:${usbId(state.device.productId)}` : "1ac2:—";

  return (
    <>
      <div className="bar-group">
        <div className="portbox">
          <label htmlFor="api">API</label>
          <input id="api" value={state.mock ? "mock" : `FullPage ${state.api?.dllVersion || "—"}`} disabled readOnly />
          <span className="baud">{usb}</span>
        </div>
        <button className={open ? "connect connect-open" : "connect"} onClick={toggle} disabled={opening}>
          {open ? "Disconnect" : opening ? "Opening…" : "Connect"}
        </button>
      </div>

      <StatusPill
        status={state.status}
        open={state.device ? `Connected · ${state.device.deviceType}, fw ${state.device.firmware}` : "Connected"}
        opening="Opening scanner"
        shut="Not connected"
      />
    </>
  );
}


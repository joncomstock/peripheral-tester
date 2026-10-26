import type { ReactNode } from "react";
import type { Snapshot, Status } from "./api.ts";
import { LAMP, lampStyle } from "./look.ts";

export type View = "home" | "lightboard" | "cardreader" | "sankyo";

interface Device {
  name: string;
  model: string;
  bus: (snapshot: Snapshot) => string;
  /** The screen that drives it, or null when no tester screen exists for it yet. */
  view: Exclude<View, "home"> | null;
}

/**
 * Every device the tester knows of: the ones it drives, and the rest of hardware-libs' drivers, which
 * are listed so someone at a kiosk can see what exists even before a screen does.
 */
const DEVICES: Record<string, Device> = {
  lightboard: { name: "Light Board", model: "IER S33380", bus: (s) => `USB · ${s.lightboard.usbId}`, view: "lightboard" },
  cardreader: { name: "Card Reader", model: "Hitachi-Omron V4K", bus: (s) => `USB HID · ${s.cardreader.usbId}`, view: "cardreader" },
  sankyo: { name: "Card Reader", model: "Sankyo ICM330", bus: (s) => `USB HID · ${s.sankyo.usbId}`, view: "sankyo" },
  passport: { name: "Passport Reader", model: "Not yet wired up", bus: () => "—", view: null },
  adr300: { name: "Document Reader", model: "Access-IS ADR300", bus: () => "USB HID · @eai/access-is", view: null },
  penta: { name: "Document Scanner", model: "DESKO Penta Gen4", bus: () => "USB · @eai/desko", view: null },
  idtech: { name: "Card Reader", model: "ID TECH Secure Mag Insert", bus: () => "USB HID · @eai/idtech", view: null },
  honeywell: { name: "Barcode Scanner", model: "Honeywell N56xx / Vuquest 3310g", bus: () => "USB · @eai/honeywell", view: null },
  datalogic: { name: "Barcode Scanner", model: "Datalogic Gryphon GFS4470", bus: () => "USB · @eai/datalogic", view: null },
  itk38: { name: "Thermal Printer", model: "Practical Automation ITK 38", bus: () => "USB · @eai/itk38", view: null },
  xpm: { name: "Thermal Printer", model: "Hengstler XPM", bus: () => "USB · @eai/xpm", view: null },
  custom: { name: "Thermal Printer", model: "CUSTOM KPM150 / KPM180", bus: () => "USB · @eai/custom", view: null },
  k8: { name: "Full-page Printer", model: "NCR K8", bus: () => "USB · @eai/k8", view: null },
  storm: { name: "Assistive Keypad", model: "Storm EZ-Access Nav-Pad", bus: () => "USB HID · @eai/storm", view: null },
  allpixel: { name: "LED Controller", model: "ManiacalLabs AllPixel", bus: () => "USB serial · @eai/maniacal-labs", view: null },
  embross: { name: "Service Switches", model: "Embross V1 button and door", bus: () => "RS-232 lines · @eai/embross", view: null },
};

/** Which devices each kiosk model is fitted with. "All Devices" is every entry above. */
export const KIOSKS = {
  "ier-919": { name: "IER 919", devices: ["lightboard", "cardreader", "passport"] },
  "sita-d4": { name: "SITA D4", devices: ["sankyo"] },
  all: { name: "All Devices", devices: Object.keys(DEVICES) },
} as const satisfies Record<string, { name: string; devices: readonly (keyof typeof DEVICES)[] }>;

export type Kiosk = keyof typeof KIOSKS;

/**
 * The dashboard: the peripherals of the chosen kiosk, and which are connected.
 *
 * A device that is not wired up yet is shown rather than hidden — knowing it is planned is worth more
 * to someone at a kiosk than a shorter list.
 */
export function Home(
  { snapshot, kiosk, onKiosk, onOpen, aside }: {
    snapshot: Snapshot;
    kiosk: Kiosk;
    onKiosk: (kiosk: Kiosk) => void;
    onOpen: (view: View) => void;
    aside: ReactNode;
  },
) {
  const statusOf = (view: Exclude<View, "home">): Status => snapshot[view].status;

  return (
    <>
      <div className="col col-wide">
        <div className="seg kiosk-picker" data-enabled role="group" aria-label="kiosk">
          {(Object.keys(KIOSKS) as Kiosk[]).map((id) => (
            <button
              key={id}
              className={kiosk === id ? "chooser chooser-on" : "chooser"}
              aria-pressed={kiosk === id}
              onClick={() => onKiosk(id)}
            >
              {KIOSKS[id].name}
            </button>
          ))}
        </div>
        <div className="tiles">
          {KIOSKS[kiosk].devices.map((id) => {
            const device = DEVICES[id];
            const ready = device.view !== null;
            const live = device.view !== null && statusOf(device.view) === "open";
            return (
              <button
                key={id}
                className={ready ? "tile" : "tile tile-planned"}
                disabled={!ready}
                onClick={() => device.view && onOpen(device.view)}
              >
                <div className="tile-head">
                  <span style={lampStyle(live ? LAMP.green : LAMP.amber, live ? "on" : "off", 18)} />
                  <span className="tile-name">{device.name}</span>
                  <span className={!ready ? "tile-badge tile-badge--planned" : live ? "tile-badge tile-badge--live" : "tile-badge"}>
                    {ready ? (live ? "Connected" : "Ready") : "Planned"}
                  </span>
                </div>
                <span className="tile-model">{device.model}</span>
                <span className="tile-bus">{device.bus(snapshot)}</span>
                <span className="tile-action">{ready ? "Open tester →" : "Coming soon"}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="col col-narrow">{aside}</div>
    </>
  );
}

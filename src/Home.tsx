import type { ReactNode } from "react";
import type { Device, Snapshot } from "./api.ts";
import * as api from "./api.ts";
import { stateOf } from "./api.ts";
import { LAMP, lampStyle } from "./look.ts";

export type DeviceId = Exclude<Device, "system">;
export type View = "home" | DeviceId;

interface Entry {
  /** What it is, as an operator would say it; the screen's title. */
  name: string;
  /** Make and model; the screen's subtitle. */
  model: string;
  /** How the backend reaches it, shown beside its USB id. */
  bus: string;
}

/** Every device the tester drives, from hardware-libs' drivers. The screen for each is in App. */
export const DEVICES: Record<DeviceId, Entry> = {
  lightboard: { name: "Light Board", model: "IER S33380", bus: "USB" },
  cardreader: { name: "Card Reader", model: "Hitachi-Omron V4K", bus: "USB HID" },
  penta: { name: "Passport Reader", model: "DESKO Penta Gen4", bus: "USB" },
  xpm: { name: "Boarding Pass Printer", model: "Hengstler XPM", bus: "USB" },
  storm: { name: "Assistive Keypad", model: "Storm EZ-Access Nav-Pad", bus: "USB HID" },
  sankyo: { name: "Card Reader", model: "Sankyo ICM330", bus: "USB HID" },
  honeywell: { name: "Barcode Reader", model: "Honeywell 5X80", bus: "USB" },
  itk38: { name: "Boarding Pass / Bag Tag Printer", model: "Practical Automation ITK38", bus: "USB" },
  adr300: { name: "Document Reader", model: "Access-IS ADR300", bus: "USB HID" },
  idtech: { name: "Card Reader", model: "ID TECH Secure Mag Insert", bus: "USB HID" },
  datalogic: { name: "Barcode Scanner", model: "Datalogic Gryphon GFS4470", bus: "USB" },
  custom: { name: "Thermal Printer", model: "CUSTOM KPM150 / KPM180", bus: "USB" },
  k8: { name: "Full-page Printer", model: "NCR K8", bus: "USB" },
  allpixel: { name: "LED Controller", model: "ManiacalLabs AllPixel", bus: "USB serial" },
  embross: { name: "Service Switches", model: "Embross V1 button and door", bus: "RS-232" },
};

/**
 * Which devices each kiosk model is fitted with, from the knowledge base's audit of each lab unit.
 * Fitted parts with no hardware-libs driver (the 919's IER 400 bag-tag printers and DESKO smart-card
 * reader, the D4's Gemalto KR2400) are left out: there is nothing to drive. "All Devices" is every entry.
 */
export const KIOSKS = {
  "ier-919": { name: "IER 919", devices: ["lightboard", "cardreader", "penta", "xpm", "storm"] },
  "sita-d4": { name: "SITA D4", devices: ["sankyo", "honeywell", "itk38"] },
  all: { name: "All Devices", devices: Object.keys(DEVICES) as DeviceId[] },
} as const satisfies Record<string, { name: string; devices: readonly DeviceId[] }>;

export type Kiosk = keyof typeof KIOSKS;

/**
 * The dashboard: the chosen kiosk's devices. A connected device is lit; any other is dark.
 *
 * Each tile opens its tester, and carries its own Connect / Disconnect so a kiosk's devices can be
 * brought up from here without visiting every screen. The tile is not one button because a button
 * may not contain another: the card body opens the tester for a pointer, and "Open tester" is the
 * keyboard's way in.
 */
export function Home(
  { snapshot, kiosk, onKiosk, onOpen, onFail, aside }: {
    snapshot: Snapshot;
    kiosk: Kiosk;
    onKiosk: (kiosk: Kiosk) => void;
    onOpen: (view: View) => void;
    onFail: (message: string) => void;
    aside: ReactNode;
  },
) {
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
            const state = stateOf(snapshot, id);
            const live = state?.status === "open";
            const opening = state?.status === "opening";
            const toggle = () => {
              if (live) api.device(id).disconnect().catch((err: Error) => onFail(err.message));
              else if (!opening) api.device(id).connect().catch((err: Error) => onFail(`Could not connect: ${err.message}`));
            };
            return (
              <div key={id} className="tile" onClick={() => onOpen(id)}>
                <div className="tile-head">
                  <span style={lampStyle(LAMP.green, live ? "on" : "off", 18)} />
                  <span className="tile-name">{device.name}</span>
                  <button
                    className={live ? "connect connect-open tile-connect" : "connect tile-connect"}
                    disabled={!state || opening}
                    aria-label={`${live ? "Disconnect" : "Connect"} ${device.name}, ${device.model}`}
                    // Its own action, not a way into the tester.
                    onClick={(event) => {
                      event.stopPropagation();
                      toggle();
                    }}
                  >
                    {live ? "Disconnect" : opening ? "Opening…" : "Connect"}
                  </button>
                </div>
                <span className="tile-model">{device.model}</span>
                <span className="tile-bus">{device.bus}{state ? ` · ${state.usbId}` : ""}</span>
                <button className="tile-action" onClick={() => onOpen(id)}>Open tester →</button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="col col-narrow">{aside}</div>
    </>
  );
}

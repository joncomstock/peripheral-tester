import type { ReactNode } from "react";
import type { Snapshot } from "./api.ts";
import { LAMP, lampStyle, usbId } from "./look.ts";

export type View = "home" | "lightboard" | "cardreader" | "passportreader";

interface Tile {
  id: View;
  name: string;
  model: string;
  bus: string;
  live: boolean;
}

/** The dashboard: which peripherals this tester can drive, and which are connected. */
export function Home(
  { snapshot, onOpen, aside }: { snapshot: Snapshot; onOpen: (view: View) => void; aside: ReactNode },
) {
  const tiles: Tile[] = [
    {
      id: "lightboard",
      name: "Light Board",
      model: "IER S33380",
      bus: `RS-232 · ${snapshot.lightboard.portName}`,
      live: snapshot.lightboard.status === "open",
    },
    {
      id: "cardreader",
      name: "Card Reader",
      model: "Hitachi-Omron V4KU",
      bus: "USB HID · 0590:0034",
      live: snapshot.cardreader.status === "open",
    },
    {
      id: "passportreader",
      name: "Passport Reader",
      model: "DESKO PENTA Scanner",
      // The USB ids only become known once the DLL has opened a device, so before that this names
      // the transport rather than inventing a pair.
      bus: snapshot.passportreader.device
        ? `USB · ${usbId(snapshot.passportreader.device.vendorId)}:${usbId(snapshot.passportreader.device.productId)}`
        : "USB · FullPage API",
      live: snapshot.passportreader.status === "open",
    },
  ];

  return (
    <>
      <div className="col col-wide">
        <div className="tiles">
        {tiles.map((tile) => (
          <button
            key={tile.id}
            className="tile"
            onClick={() => onOpen(tile.id)}
          >
            <div className="tile-head">
              <span style={lampStyle(tile.live ? LAMP.green : LAMP.amber, tile.live ? "on" : "off", 18)} />
              <span className="tile-name">{tile.name}</span>
              <span className={tile.live ? "tile-badge tile-badge--live" : "tile-badge"}>{tile.live ? "Connected" : "Ready"}</span>
            </div>
            <span className="tile-model">{tile.model}</span>
            <span className="tile-bus">{tile.bus}</span>
            <span className="tile-action">Open tester →</span>
          </button>
          ))}
        </div>
      </div>
      <div className="col col-narrow">{aside}</div>
    </>
  );
}


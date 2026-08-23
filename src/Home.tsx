import type { ReactNode } from "react";
import type { Snapshot } from "./api.ts";
import { LAMP, lampStyle } from "./look.ts";

export type View = "home" | "lightboard" | "cardreader" | "passportreader";

interface Tile {
  id: View;
  name: string;
  model: string;
  bus: string;
  ready: boolean;
  live: boolean;
}

/**
 * The dashboard: which peripherals this tester can drive, and which are connected.
 *
 * A device that is not wired up yet is shown rather than hidden — knowing what a kiosk has is worth
 * more to someone standing at one than a shorter list.
 */
export function Home(
  { snapshot, onOpen, aside }: { snapshot: Snapshot; onOpen: (view: View) => void; aside: ReactNode },
) {
  const tiles: Tile[] = [
    {
      id: "lightboard",
      name: "Light Board",
      model: "IER S33380",
      bus: `RS-232 · ${snapshot.lightboard.portName}`,
      ready: true,
      live: snapshot.lightboard.status === "open",
    },
    {
      id: "cardreader",
      name: "Card Reader",
      model: "Hitachi-Omron V4KU",
      bus: "USB HID · 0590:0034",
      ready: true,
      live: snapshot.cardreader.status === "open",
    },
    {
      id: "passportreader",
      name: "Passport Reader",
      model: "DESKO PENTA Scanner",
      // The USB ids only become known once the DLL has opened a device, so before that this names
      // the transport rather than inventing a pair.
      bus: snapshot.passportreader.device
        ? `USB · ${hex(snapshot.passportreader.device.vendorId)}:${hex(snapshot.passportreader.device.productId)}`
        : "USB · FullPage API",
      ready: true,
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
            className={tile.ready ? "tile" : "tile tile-planned"}
            disabled={!tile.ready}
            onClick={() => tile.ready && onOpen(tile.id)}
          >
            <div className="tile-head">
              <span style={lampStyle(tile.live ? LAMP.green : LAMP.amber, tile.live ? "on" : "off", 18)} />
              <span className="tile-name">{tile.name}</span>
              <span className={badgeClass(tile)}>{tile.ready ? (tile.live ? "Connected" : "Ready") : "Planned"}</span>
            </div>
            <span className="tile-model">{tile.model}</span>
            <span className="tile-bus">{tile.bus}</span>
            <span className="tile-action">{tile.ready ? "Open tester →" : "Coming soon"}</span>
          </button>
          ))}
        </div>
      </div>
      <div className="col col-narrow">{aside}</div>
    </>
  );
}

const hex = (value: number) => value.toString(16).padStart(4, "0");

function badgeClass(tile: Tile): string {
  if (!tile.ready) return "tile-badge tile-badge--planned";
  return tile.live ? "tile-badge tile-badge--live" : "tile-badge";
}

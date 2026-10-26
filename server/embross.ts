/**
 * The Embross V1's service button and door switch, as one device of the tester.
 *
 * Both are dry contacts on the PC's RS-232 handshake lines: RTS is their common, the button closes
 * onto CTS and the shut door onto DSR. No bytes cross the port, so there is nothing to send; this
 * reports what the switches do and which port is read. Nothing the driver offers is destructive.
 *
 * @module
 */

import type { SerialInputSignals } from "@eai/serial";
import { DEFAULT_PORT, EmbrossSwitches, openEmbrossSwitches } from "@eai/embross";
import type { SwitchLines } from "@eai/embross";
import { announce, record } from "./activity.ts";

const log = (kind: string, text: string) => record("embross", kind, text);

/**
 * Faster than the driver's 500 ms: a deliberate press measured over 200 ms on the bench, so at the
 * default some presses fall between samples, and a tester that misses a press reads as a bad switch.
 */
const POLL_INTERVAL_MS = 100;

/** A Windows COM port or a Unix serial device; anything else is not a port the driver can open. */
const PORT_PATTERN = /^(COM[1-9]\d{0,2}|\/dev\/(tty|cu\.)[\w.-]{1,32})$/;

/** How many transitions the page keeps on screen; the activity log holds the rest. */
const MAX_TRANSITIONS = 20;

// ---------------------------------------------------------------------------------------------
// A fake port, for driving the page without hardware.
// ---------------------------------------------------------------------------------------------

/**
 * The handshake lines of a port with the switches wired as on the kiosk: DSR asserted while the
 * door is shut, CTS while the button is held. The driver samples it like the real port.
 */
class MockLines implements SwitchLines {
  isOpen = true;
  #inputs: SerialInputSignals = { clearToSend: false, dataSetReady: true, dataCarrierDetect: false, ringIndicator: false };

  getSignals(): SerialInputSignals {
    return { ...this.#inputs };
  }

  setSignals(): void {}

  close(): void {
    this.isOpen = false;
  }

  door(open: boolean): void {
    this.#inputs.dataSetReady = !open;
  }

  button(pressed: boolean): void {
    this.#inputs.clearToSend = pressed;
  }
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export type Status = "closed" | "opening" | "open";

let switches: EmbrossSwitches | null = null;
let mockLines: MockLines | null = null;
let status: Status = "closed";
let mock = false;
let port = DEFAULT_PORT;
let doorOpen: boolean | null = null;
let buttonPressed: boolean | null = null;
/** Newest first. Times are the server's, so they agree with the activity log. */
let transitions: { at: string; text: string }[] = [];

export const state = () => ({
  status,
  mock,
  usbId: mock ? "mock handshake lines" : `${port} handshake lines`,
  port,
  defaultPort: DEFAULT_PORT,
  pollIntervalMs: POLL_INTERVAL_MS,
  /** Unknown until connected: the switches are only read while the port is held. */
  doorOpen,
  buttonPressed,
  transitions,
});

const tell = () => announce("embross", state());

export function configure(options: { mock: boolean }): void {
  // A device opened in one mode must never carry on into the other.
  if (status !== "closed") throw new Error("Disconnect before changing mode");
  mock = options.mock;
  tell();
}

function transition(text: string): void {
  transitions = [{ at: new Date().toISOString().slice(11, 19), text }, ...transitions].slice(0, MAX_TRANSITIONS);
  log("info", text);
  tell();
}

function wire(opened: EmbrossSwitches): void {
  opened.on("door", (open: boolean) => {
    doorOpen = open;
    transition(open ? "Door opened" : "Door shut");
  });
  opened.on("button", (pressed: boolean) => {
    buttonPressed = pressed;
    transition(pressed ? "Service button pressed" : "Service button released");
  });
  // The driver has already stopped sampling and closed the port.
  opened.on("error", (err: Error) => {
    if (switches !== opened) return;
    switches = null;
    mockLines = null;
    status = "closed";
    doorOpen = null;
    buttonPressed = null;
    log("error", `${err.message}. The port stopped answering; reconnect to continue.`);
    tell();
  });
}

export async function connect(): Promise<void> {
  if (status !== "closed") return;
  status = "opening";
  transitions = [];
  tell();
  log("info", mock ? "Opening mock handshake lines" : `Opening ${port}`);
  try {
    if (mock) {
      mockLines = new MockLines();
      switches = await EmbrossSwitches.withTransport(mockLines, { pollIntervalMs: POLL_INTERVAL_MS });
    }
    else {
      switches = await openEmbrossSwitches({ port, pollIntervalMs: POLL_INTERVAL_MS });
    }
    wire(switches);
  }
  catch (err) {
    await switches?.close().catch(() => {});
    switches = null;
    mockLines = null;
    status = "closed";
    tell();
    log("error", err instanceof Error ? err.message : String(err));
    throw err;
  }
  ({ doorOpen, buttonPressed } = switches.state);
  status = "open";
  tell();
  log("ok", `Reading the switches: door ${doorOpen ? "open" : "shut"}, button ${buttonPressed ? "pressed" : "up"}`);
}

export async function disconnect(): Promise<void> {
  const open = switches;
  if (!open) return;
  switches = null;
  status = "closed";
  // Nothing to darken: the switches are inputs. Closing drops RTS with the port.
  await open.close().catch((err) => log("warned", `Port did not close cleanly: ${err instanceof Error ? err.message : err}`));
  mockLines = null;
  doorOpen = null;
  buttonPressed = null;
  tell();
  log("info", "Port released");
}

function text(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") throw new Error(`'${field}' must be a string`);
  return value;
}

export const actions: Record<string, (body: Record<string, unknown>) => unknown> = {
  /** Choose the port the switches are wired to. Takes effect on the next connect. */
  port(body) {
    const next = text(body, "port").trim();
    if (status !== "closed") throw new Error("Disconnect before changing port");
    if (!PORT_PATTERN.test(next)) throw new Error(`'${next}' is not a serial port (COM1, /dev/ttyS0, …)`);
    port = next;
    tell();
    log("info", `Port set to ${port}`);
  },

  /** Work a simulated switch. The page offers this only when mocking. */
  simulate(body) {
    if (!mock || !mockLines) throw new Error("Only mock switches can be simulated");
    const which = text(body, "switch");
    const on = body.on;
    if (typeof on !== "boolean") throw new Error("'on' must be true or false");
    if (which === "door") mockLines.door(on);
    else if (which === "button") mockLines.button(on);
    else throw new Error(`unknown switch '${which}'`);
  },
};

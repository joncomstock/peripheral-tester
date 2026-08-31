/**
 * The drivers' own warnings, onto the page.
 *
 * `@eai/*` reports a mismatched acknowledgement through its logger, which means this process's
 * stdout — where an operator standing at a device with the page in front of them has no reason to
 * be looking. Those warnings are the only place a *reply token* appears: the page can say a read
 * failed with status `10` while `Track read answered P6a10`, which says the device answered
 * positively, is visible nowhere. That is the difference between a device that refused and a
 * device whose answer the driver declined to use.
 *
 * The light board has had this since it was written and the card reader grew its own copy, so it
 * lived here twice, comments included. One device gaining a fix the other did not is the failure
 * that costs a bench session, and it is the reason this is one module.
 *
 * @module
 */

import { attachHandler } from "@eai/logging-ts";
import { BaseHandler } from "@std/log";
import type { LogRecord } from "@std/log";
import { record } from "./activity.ts";
import type { Device } from "./activity.ts";

/**
 * Logger names already carrying a handler.
 *
 * `attachHandler` pushes onto the logger's handler list, so reconnecting to the same device would
 * attach a second copy and every driver warning would arrive twice.
 */
const attached = new Set<string>();

class WarningsToPage extends BaseHandler {
  readonly #device: Device;

  constructor(device: Device) {
    super("WARN");
    this.#device = device;
  }

  /** Warnings only: a driver's `error` calls already reach the page through its `error` event. */
  override handle(entry: LogRecord): void {
    if (entry.levelName === "WARN") record(this.#device, "warned", entry.msg);
  }

  /** Abstract on the base class, and unreachable here: `handle` never enters the formatting path. */
  override log(): void {
    throw new Error("unreachable");
  }
}

/** Put one driver logger's warnings on the page, at most once per logger. */
export function listenForWarnings(device: Device, loggerName: string): void {
  if (attached.has(loggerName)) return;
  attachHandler(loggerName, new WarningsToPage(device));
  attached.add(loggerName);
}

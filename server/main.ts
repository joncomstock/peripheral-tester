/**
 * Peripheral tester — backend.
 *
 * Owns every device the page can drive and exposes them over one local JSON + SSE API. The browser
 * never touches hardware: the light board is a USB interface held by this process, the card readers
 * USB HID handles, and every driver is Deno-native. Each device is its own session, so any of them
 * can be connected at once — a kiosk is tested as a whole, not one peripheral at a time.
 *
 * These are control panels, not probes. They drive the peripherals and report what came back; where
 * a channel map or a setting turns out to be wrong for a kiosk, the fix is configuration passed to
 * the driver.
 *
 * ```
 * deno task dev                 # serves the UI; connect to a device from the page
 * deno task dev:mock            # no hardware
 * ```
 *
 * `--mock` drives fake transports through the real drivers, so the command construction, framing and
 * reply matching under test are the shipped ones. It only sets the starting mode: the page's Settings
 * panel switches every device between mock and real at runtime.
 *
 * @module
 */

import { delay } from "@std/async";
import { join } from "@std/path";
import { serveDir } from "@std/http/file-server";
import type { LedRequest } from "@eai/ier/s33380";
import type { LedColor, TransactionSetting } from "@eai/omron-v4k";
import type { LedColor as SankyoLedColor } from "@eai/sankyo";
import type { ExternalLedColor as PentaStripColor, LedColor as PentaLedColor } from "@eai/desko/penta";
import * as activity from "./activity.ts";
import * as lightboard from "./lightboard.ts";
import * as cardreader from "./cardreader.ts";
import * as sankyo from "./sankyo.ts";
import * as penta from "./penta.ts";
import * as custom from "./custom.ts";
import * as datalogic from "./datalogic.ts";
import * as honeywell from "./honeywell.ts";
import * as idtech from "./idtech.ts";
import * as adr300 from "./adr300.ts";
import * as itk38 from "./itk38.ts";
import * as allpixel from "./allpixel.ts";
import * as k8 from "./k8.ts";
import * as xpm from "./xpm.ts";
import * as storm from "./storm.ts";
import * as embross from "./embross.ts";

let mock = Deno.args.includes("--mock");
/** Real devices load libusb and hidapi, so they need FFI; `dev:mock` deliberately runs without it. */
const hardwareAllowed = Deno.permissions.querySync({ name: "ffi" }).state === "granted";
const port = Number(Deno.env.get("PORT") ?? 8777);

const here = import.meta.dirname;
if (here === undefined) throw new Error("run this from a checkout: the built UI is served from ./dist");
const distDir = join(here, "..", "dist");
const built = await Deno.stat(join(distDir, "index.html")).then(() => true).catch(() => false);

/**
 * What every device module exports. `actions` are its page's commands, reached generically at
 * `/api/<device>/<action>` with the request body; each validates its own input, since the body comes
 * straight off the wire. The first four devices predate this and route their commands explicitly.
 */
interface Session {
  configure(options: { mock: boolean }): void;
  state(): { status: string };
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  actions?: Record<string, (body: Record<string, unknown>) => unknown>;
}

/** Every device session. Whatever is done to all of them — mode, disconnect, shutdown — goes through here. */
const sessions: Record<string, Session> = {
  lightboard,
  cardreader,
  penta,
  xpm,
  storm,
  sankyo,
  honeywell,
  itk38,
  adr300,
  idtech,
  datalogic,
  custom,
  k8,
  allpixel,
  embross,
};
const devices = Object.values(sessions);
const disconnectAll = () => Promise.all(devices.map((device) => device.disconnect())).then(() => {});

for (const device of devices) device.configure({ mock });

const json = (body: unknown, statusCode = 200) =>
  new Response(JSON.stringify(body), { status: statusCode, headers: { "content-type": "application/json" } });

/** Everything the page needs to render any screen, in one request. */
const snapshot = () => ({
  mock,
  hardwareAllowed,
  log: activity.history(),
  ...Object.fromEntries(Object.entries(sessions).map(([id, session]) => [id, session.state()])),
  lightboard: { ...lightboard.state(), vocabulary: lightboard.vocabulary() },
});

/** Set while a switch is disconnecting devices, so no device can be opened in the outgoing mode. */
let switching = false;

/**
 * Switch every device between mock and real.
 *
 * Everything is disconnected first, so nothing opened in one mode keeps running in the other: a page
 * that says "mock" while driving a real board, or the reverse, is the mistake this prevents.
 */
async function setMock(next: boolean): Promise<void> {
  if (next === mock) return;
  if (switching) throw new Error("Already switching mode");
  if (!next && !hardwareAllowed) {
    throw new Error("Real devices need FFI permission: restart with `deno task dev`");
  }
  // A device still opening has no handle to disconnect yet; switching under it would leave the
  // devices split between modes. Refuse before anything changes.
  if (devices.some((device) => device.state().status === "opening")) {
    throw new Error("A device is still opening; try again once it has");
  }
  switching = true;
  try {
    await disconnectAll();
    mock = next;
    for (const device of devices) device.configure({ mock });
  }
  finally {
    switching = false;
  }
  activity.announceMode(mock);
  activity.record("system", "info", mock ? "Mock mode on: every device is simulated" : "Mock mode off: devices are real");
}

/** Runs a device action and turns a refusal into an answer rather than a stack trace. */
async function attempt(work: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    const result = await work();
    return json({ ok: true, ...(result && typeof result === "object" ? result : {}) });
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: message }, 500);
  }
}

async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const post = request.method === "POST";
  const body = async <T>(): Promise<Partial<T>> => post ? await request.json().catch(() => ({})) as Partial<T> : {};

  if (pathname === "/api/state") return json(snapshot());

  if (post && switching && pathname.endsWith("/connect")) {
    return json({ ok: false, error: "Switching between mock and real; connect again in a moment" }, 409);
  }

  if (pathname === "/api/events") {
    return activity.eventStream(() => ({ type: "hello", ...snapshot() }));
  }

  // ---- light board ----

  if (post && pathname === "/api/lightboard/connect") return await attempt(() => lightboard.connect());
  if (post && pathname === "/api/lightboard/disconnect") return await attempt(() => lightboard.disconnect());
  if (post && pathname === "/api/lightboard/led") {
    const request_ = await request.json() as LedRequest;
    return await attempt(() => lightboard.led(request_));
  }
  if (post && pathname === "/api/lightboard/all-off") return await attempt(() => lightboard.allOff());
  if (post && pathname === "/api/lightboard/door") {
    const { door } = await body<{ door: "upper" | "lower" }>();
    return await attempt(() => lightboard.simulateDoor(door === "lower" ? "lower" : "upper"));
  }

  // ---- card reader ----

  if (post && pathname === "/api/cardreader/connect") return await attempt(() => cardreader.connect());
  if (post && pathname === "/api/cardreader/disconnect") return await attempt(() => cardreader.disconnect());
  if (post && pathname === "/api/cardreader/reset") return await attempt(() => cardreader.reset());
  if (post && pathname === "/api/cardreader/clear") return await attempt(() => cardreader.clearRead());
  if (post && pathname === "/api/cardreader/settings") {
    const next = await body<TransactionSetting & { seconds: number }>();
    return await attempt(async () => {
      const { seconds, ...setting } = next;
      if (seconds !== undefined) cardreader.monitorSeconds(seconds);
      if (Object.keys(setting).length > 0) await cardreader.settings(setting);
    });
  }
  if (post && pathname === "/api/cardreader/led") {
    const { color, blink } = await body<{ color: LedColor | "off"; blink: boolean }>();
    return await attempt(() => cardreader.setLed(color ?? "off", blink));
  }
  // The one response carrying cardholder data. It is answered to the caller and never recorded.
  if (post && pathname === "/api/cardreader/read") return await attempt(() => cardreader.read());
  if (post && pathname === "/api/cardreader/cancel") return await attempt(() => cardreader.cancel());
  if (post && pathname === "/api/cardreader/listen") return await attempt(() => cardreader.startListening());
  if (post && pathname === "/api/cardreader/stop") return await attempt(() => cardreader.stopListening());
  // Single-shot: the card leaves once, to whoever asked. It is never put on the shared event stream.
  if (post && pathname === "/api/cardreader/take-card") {
    return await attempt(() => ({ card: cardreader.takeCard() }));
  }
  if (post && pathname === "/api/cardreader/identity") return await attempt(() => cardreader.identity());
  if (post && pathname === "/api/cardreader/led-mode") {
    const { mode } = await body<{ mode: "manual" | "automatic" }>();
    return await attempt(() => cardreader.setLedMode(mode === "automatic" ? "automatic" : "manual"));
  }
  if (post && pathname === "/api/cardreader/arm") {
    const { outcome } = await body<{ outcome: cardreader.NextOutcome }>();
    return await attempt(() => cardreader.arm(outcome ?? "card"));
  }

  // ---- Sankyo card reader ----

  if (post && pathname === "/api/sankyo/connect") return await attempt(() => sankyo.connect());
  if (post && pathname === "/api/sankyo/disconnect") return await attempt(() => sankyo.disconnect());
  if (post && pathname === "/api/sankyo/seconds") {
    const { seconds } = await body<{ seconds: number }>();
    return await attempt(() => {
      if (typeof seconds !== "number") throw new Error("seconds is required");
      sankyo.monitorSeconds(seconds);
    });
  }
  if (post && pathname === "/api/sankyo/led") {
    const { color, blink } = await body<{ color: SankyoLedColor; blink: boolean }>();
    return await attempt(() => sankyo.setLed(color ?? "off", blink === true));
  }
  // Like the V4K's: the card is answered to the caller and never recorded or broadcast.
  if (post && pathname === "/api/sankyo/read") return await attempt(() => sankyo.read());
  if (post && pathname === "/api/sankyo/cancel") return await attempt(() => sankyo.cancel());
  if (post && pathname === "/api/sankyo/listen") return await attempt(() => sankyo.startListening());
  if (post && pathname === "/api/sankyo/stop") return await attempt(() => sankyo.stopListening());
  if (post && pathname === "/api/sankyo/take-card") return await attempt(() => ({ card: sankyo.takeCard() }));
  if (post && pathname === "/api/sankyo/identity") return await attempt(() => sankyo.identity());
  if (post && pathname === "/api/sankyo/card") {
    const { inserted } = await body<{ inserted: boolean }>();
    return await attempt(() => sankyo.simulateCard(inserted === true));
  }

  // ---- DESKO Penta ----

  if (post && pathname === "/api/penta/connect") return await attempt(() => penta.connect());
  if (post && pathname === "/api/penta/disconnect") return await attempt(() => penta.disconnect());
  if (post && pathname === "/api/penta/status-led") {
    const { mode, color } = await body<{ mode: "on" | "flash" | "off"; color: PentaLedColor }>();
    return await attempt(() => penta.setStatusLed(mode === "on" || mode === "flash" ? mode : "off", color));
  }
  if (post && pathname === "/api/penta/external-led") {
    const { color } = await body<{ color: PentaStripColor | "off" }>();
    return await attempt(() => penta.setExternalLed(color ?? "off"));
  }
  if (post && pathname === "/api/penta/beep") return await attempt(() => penta.beep());
  if (post && pathname === "/api/penta/flood") {
    const { level } = await body<{ level: number }>();
    return await attempt(() => {
      if (typeof level !== "number") throw new Error("level is required");
      return penta.setFloodLevel(level);
    });
  }
  if (post && pathname === "/api/penta/identity") return await attempt(() => penta.identity());
  if (post && pathname === "/api/penta/simulate") {
    const { action } = await body<{ action: "place" | "boarding-pass" | "flip" | "remove" }>();
    return await attempt(() => {
      if (!["place", "boarding-pass", "flip", "remove"].includes(action ?? "")) throw new Error(`unknown action '${action}'`);
      penta.simulate(action!);
    });
  }

  // ---- every other device: connect, disconnect, and its own actions ----

  const route = post ? pathname.match(/^\/api\/([a-z0-9]+)\/([a-z0-9-]+)$/) : null;
  const session = route ? sessions[route[1]] : undefined;
  if (route && session) {
    const action = route[2];
    if (action === "connect") return await attempt(() => session.connect());
    if (action === "disconnect") return await attempt(() => session.disconnect());
    const run = session.actions && Object.hasOwn(session.actions, action) ? session.actions[action] : undefined;
    if (run) {
      const payload = await body<Record<string, unknown>>();
      return await attempt(() => run(payload as Record<string, unknown>));
    }
  }

  if (post && pathname === "/api/disconnect-all") {
    return await attempt(disconnectAll);
  }
  if (post && pathname === "/api/settings/mock") {
    const { on } = await body<{ on: boolean }>();
    return await attempt(() => setMock(on === true));
  }

  if (pathname.startsWith("/api/")) return new Response("not found", { status: 404 });

  // The UI. On a kiosk this process serves it too, so there is one thing to start.
  if (!built) {
    return new Response(
      "The UI has not been built. Run `npm install && npm run build`, or `npm run dev` for a dev server on :5175.",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  return await serveDir(request, { fsRoot: distDir, quiet: true });
}

console.log(`  Peripheral tester${mock ? " — MOCK devices" : ""}`);
console.log(built ? `  open http://localhost:${port}/` : `  API on :${port} — UI not built, run \`npm run dev\` (:5175)`);
console.log(`  pick a device from the page\n`);

const server = Deno.serve({ port, onListen: () => {} }, handle);

// Leave every device dark and every handle released on Ctrl-C, so the next run can open them.
Deno.addSignalListener("SIGINT", async () => {
  console.log("\n  shutting down: releasing devices");
  await disconnectAll();
  await server.shutdown();
  Deno.exit(0);
});

await delay(0);

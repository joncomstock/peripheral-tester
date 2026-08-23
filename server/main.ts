/**
 * Peripheral tester — backend.
 *
 * Owns every device the page can drive and exposes them over one local JSON + SSE API. The browser
 * never touches hardware: the light board is a COM port held by this process, the card reader a USB
 * HID handle, the passport reader a loaded `PageScanAPI.dll`, and every driver is Deno-native.
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
 * reply matching under test are the shipped ones.
 *
 * @module
 */

import { delay } from "@std/async";
import { join } from "@std/path";
import { serveDir } from "@std/http/file-server";
import type { LedRequest } from "@eai/ier/s33380";
import type { LedColor, TransactionSetting } from "@eai/omron/v4ku";
import type { ImageFormat, LedColorName, LightSourceName, ResolutionName } from "@eai/desko/penta";
import * as activity from "./activity.ts";
import * as lightboard from "./lightboard.ts";
import * as cardreader from "./cardreader.ts";
import * as passportreader from "./passportreader.ts";

const args = Deno.args.filter((a) => a !== "--mock");
const mock = Deno.args.includes("--mock");
const port = Number(Deno.env.get("PORT") ?? 8777);

const here = import.meta.dirname;
if (here === undefined) throw new Error("run this from a checkout: the built UI is served from ./dist");
const distDir = join(here, "..", "dist");
const built = await Deno.stat(join(distDir, "index.html")).then(() => true).catch(() => false);

lightboard.configure({ mock, portName: args[0] });
cardreader.configure({ mock });
passportreader.configure({ mock, dllPath: Deno.env.get("DESKO_PAGESCAN_DLL_PATH") });

const json = (body: unknown, statusCode = 200) =>
  new Response(JSON.stringify(body), { status: statusCode, headers: { "content-type": "application/json" } });

/** Everything the page needs to render any screen, in one request. */
const snapshot = () => ({
  mock,
  log: activity.history(),
  lightboard: { ...lightboard.state(), vocabulary: lightboard.vocabulary() },
  cardreader: cardreader.state(),
  passportreader: passportreader.state(),
});

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

  if (pathname === "/api/events") {
    return activity.eventStream(() => ({ type: "hello", ...snapshot() }));
  }

  // ---- light board ----

  if (post && pathname === "/api/lightboard/connect") {
    const { portName } = await body<{ portName: string }>();
    return await attempt(() => lightboard.connect(portName));
  }
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
    return await attempt(() => {
      const { seconds, ...setting } = next;
      if (seconds !== undefined) cardreader.monitorSeconds(seconds);
      if (Object.keys(setting).length > 0) cardreader.settings(setting);
    });
  }
  if (post && pathname === "/api/cardreader/led") {
    const { color } = await body<{ color: LedColor | "off" }>();
    return await attempt(() => cardreader.setLed(color ?? "off"));
  }
  // The one response carrying cardholder data. It is answered to the caller and never recorded.
  if (post && pathname === "/api/cardreader/read") return await attempt(() => cardreader.read());
  if (post && pathname === "/api/cardreader/cancel") return await attempt(() => cardreader.cancel());
  if (post && pathname === "/api/cardreader/arm") {
    const { outcome } = await body<{ outcome: cardreader.NextOutcome }>();
    return await attempt(() => cardreader.arm(outcome ?? "card"));
  }

  // ---- passport reader ----

  if (post && pathname === "/api/passportreader/connect") return await attempt(() => passportreader.connect());
  if (post && pathname === "/api/passportreader/disconnect") return await attempt(() => passportreader.disconnect());
  if (post && pathname === "/api/passportreader/settings") {
    const next = await body<{ lights: LightSourceName[]; resolution: ResolutionName }>();
    return await attempt(() => passportreader.settings(next));
  }
  if (post && pathname === "/api/passportreader/led") {
    const { color } = await body<{ color: LedColorName | "off" }>();
    return await attempt(() => passportreader.setLed(color ?? "off"));
  }
  if (post && pathname === "/api/passportreader/buzz") return await attempt(() => passportreader.buzz());
  // The one response carrying document data. It is answered to the caller and never recorded.
  if (post && pathname === "/api/passportreader/read") return await attempt(() => passportreader.read());
  if (post && pathname === "/api/passportreader/arm") {
    const { outcome } = await body<{ outcome: passportreader.NextOutcome }>();
    return await attempt(() => passportreader.arm(outcome ?? "passport"));
  }
  /**
   * The scanned page, as image bytes.
   *
   * A GET so the page can point an `<img>` at it. `no-store` because the response is a picture of
   * somebody's passport: it is served once to the tab that asked and must not sit in a disk cache
   * afterwards.
   */
  if (pathname === "/api/passportreader/image") {
    const query = new URL(request.url).searchParams;
    const light = (query.get("light") ?? "visible") as LightSourceName;
    const format = (query.get("format") ?? "jpeg") as ImageFormat;
    try {
      const scan = await passportreader.image(light, format);
      // Copied into an array backed by a plain ArrayBuffer, which is what a `Response` body accepts.
      return new Response(new Uint8Array(scan.bytes), {
        headers: { "content-type": scan.mimeType, "cache-control": "no-store" },
      });
    }
    catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
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
  await lightboard.disconnect();
  await cardreader.disconnect();
  await passportreader.disconnect();
  await server.shutdown();
  Deno.exit(0);
});

await delay(0);

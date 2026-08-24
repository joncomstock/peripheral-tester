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
import { LightSource } from "@eai/desko/penta";
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

/**
 * Is `key` one of this vocabulary's own entries?
 *
 * `Object.hasOwn`, not `in`: `in` walks the prototype chain, so `"toString" in Resolution` is true
 * and a request for `?resolution=toString` would pass a check meant to reject it — then reach the
 * packed struct as a function, which `setUint32` writes as 0. That is the silent scan at the
 * undefined resolution this validation exists to prevent, arriving through the validation itself.
 */
const known = (vocabulary: object, key: string | undefined): boolean => key !== undefined && Object.hasOwn(vocabulary, key);

/** Encodings the image route accepts. Typed so a format added to the driver fails to compile here. */
const IMAGE_FORMATS: Record<ImageFormat, true> = { jpeg: true, png: true, bmp: true };

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
    // Checked rather than cast. An unknown resolution reaches the packed struct as `undefined`,
    // which `setUint32` writes as 0 — a silent scan at the undefined resolution rather than a
    // refusal.
    //
    // Checked against what is *selectable*, not against the whole enum. `Resolution` includes the
    // vendor's own `undefined` member, whose value is 0 — so validating against the enum accepted
    // by name the exact scan this check exists to prevent, through the one door the page does not
    // offer. The served vocabulary is the authority, so the two cannot disagree again.
    const selectable = passportreader.vocabulary().resolutions as readonly string[];
    if (next.resolution !== undefined && !selectable.includes(next.resolution)) {
      return json({ ok: false, error: `unknown resolution: ${next.resolution}` }, 400);
    }
    const unknownLight = next.lights?.find((light) => !known(LightSource, light));
    if (unknownLight !== undefined) return json({ ok: false, error: `unknown light source: ${unknownLight}` }, 400);
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
    const light = query.get("light") ?? "visible";
    if (!known(LightSource, light)) return json({ ok: false, error: `unknown light source: ${light}` }, 400);
    // The page never asks for an encoding — JPEG is what a full-page scan wants — but the query is
    // kept and validated, because reaching for `&format=png` by hand is exactly how someone checks
    // the driver's other two image paths on a kiosk. Under mock only BMP can be produced.
    const format = query.get("format") ?? "jpeg";
    if (!known(IMAGE_FORMATS, format)) return json({ ok: false, error: `unknown image format: ${format}` }, 400);
    try {
      const scan = await passportreader.image(light as LightSourceName, format as ImageFormat);
      // No copy: `DocumentImage.bytes` is ArrayBuffer-backed, which is what a `Response` body takes.
      return new Response(scan.bytes, {
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

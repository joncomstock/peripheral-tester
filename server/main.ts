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
import type {
  ImageFormat,
  ImageRegion,
  LedColorName,
  LedUsageName,
  LightSourceName,
  ReadMrzOptions,
  ResolutionName,
} from "@eai/desko/penta";
import * as activity from "./activity.ts";
// Type-only, so nothing here loads a driver. The modules themselves are imported below, at runtime,
// and these name the two outcome unions the arm routes take. The light board has no such union, so
// it needs no type import of its own.
import type * as lightboardModule from "./lightboard.ts";
import type * as CardReaderModule from "./cardreader.ts";
import type * as PassportReaderModule from "./passportreader.ts";

const args = Deno.args.filter((a) => a !== "--mock");
const mock = Deno.args.includes("--mock");
const port = Number(Deno.env.get("PORT") ?? 8777);

const here = import.meta.dirname;
if (here === undefined) throw new Error("run this from a checkout: the built UI is served from ./dist");
const distDir = join(here, "..", "dist");
const built = await Deno.stat(join(distDir, "index.html")).then(() => true).catch(() => false);

/**
 * Why a device is not on this bench, if it is not.
 *
 * Keyed by the same ids the page uses, so an absent device is reported rather than inferred from a
 * missing field.
 */
const absent: Partial<Record<"lightboard" | "cardreader" | "passportreader", string>> = {};

/**
 * A device module, or `null` when its driver is not in this checkout.
 *
 * The drivers are unpublished and live on `hardware-libs` branches that have not merged, so which
 * of them a checkout can resolve depends on the branch it is on: `omron/` is only on
 * `feat/omron-v4ku`, `desko/` only on `feat/desko-penta`. Statically imported, the first one
 * missing takes the whole backend down and the other two devices go with it — so a bench that only
 * wanted the card reader could not start because the light board's driver had moved on.
 *
 * Imported dynamically instead: an unresolvable specifier inside the module rejects the `import()`
 * rather than failing to link this one, and that is catchable. The device then reports itself
 * unavailable and every other device still works.
 *
 * The reason is kept verbatim. "Module ... has no exported member 'DEFAULT_PORT'" is what tells you
 * the driver moved rather than that the hardware is unplugged.
 */
async function load<T>(
  device: "lightboard" | "cardreader" | "passportreader",
  importing: Promise<T>,
): Promise<T | null> {
  try {
    return await importing;
  }
  catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    absent[device] = reason;
    activity.record(device, "error", `Driver not in this checkout — ${reason}`);
    return null;
  }
}

const lightboard = await load("lightboard", import("./lightboard.ts"));
const cardreader = await load("cardreader", import("./cardreader.ts"));
const passportreader = await load("passportreader", import("./passportreader.ts"));

/**
 * The light board's USB serial adapter, from the command line or the environment.
 *
 * `<hex-vid> <hex-pid> <cdc-acm|ftdi> [serial]` positionally, the same words and the same order as
 * `@eai/ier`'s own examples take, or `IER_LIGHTBOARD_USB` as one comma-separated string for a
 * service that has no argv to spare. Nothing is defaulted: the driver has no default adapter until
 * the deployed one is captured, so an absent identity means the board says it is unconfigured
 * rather than opening whatever else matches.
 */
function lightboardUsb(): lightboardModule.Usb | null {
  const fromEnv = Deno.env.get("IER_LIGHTBOARD_USB")?.split(",").map((part) => part.trim());
  const [vidText, pidText, adapterText, serialNumber] = fromEnv?.length ? fromEnv : args;
  if (!vidText || !pidText) return null;
  if (adapterText !== "cdc-acm" && adapterText !== "ftdi") return null;
  const vendorId = Number.parseInt(vidText, 16);
  const productId = Number.parseInt(pidText, 16);
  // `parseInt` answers NaN rather than throwing, and NaN would reach libusb as a device nobody
  // asked for. A malformed pair is no identity at all.
  if (!Number.isInteger(vendorId) || !Number.isInteger(productId)) return null;
  return { vendorId, productId, adapter: adapterText, serialNumber: serialNumber || undefined };
}

lightboard?.configure({ mock, usb: lightboardUsb() });
cardreader?.configure({ mock });
passportreader?.configure({ mock, dllPath: Deno.env.get("DESKO_PAGESCAN_DLL_PATH") });

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

/** Regions the image route accepts. Typed for the same reason. */
const IMAGE_REGIONS: Record<ImageRegion, true> = { full: true, document: true };

/** LED behaviours the route accepts, typed for the same reason. */
const LED_USAGES: Record<LedUsageName, true> = { permanent: true, flashing: true };

/**
 * Where the route will let recognition run, typed for the same reason.
 *
 * Keyed off the driver's own option rather than a pair of string literals: the source selects which
 * pair of native calls a read makes, so a driver that grows a third has to be handled here rather
 * than silently 400ing.
 */
const OCR_SOURCES: Record<NonNullable<ReadMrzOptions["source"]>, true> = { pc: true, device: true };

const json = (body: unknown, statusCode = 200) =>
  new Response(JSON.stringify(body), { status: statusCode, headers: { "content-type": "application/json" } });

/** Everything the page needs to render any screen, in one request. */
const snapshot = () => ({
  mock,
  // Named rather than left to a missing field: the page draws an absent device differently from a
  // disconnected one, and it needs the reason to say which.
  absent,
  log: activity.history(),
  lightboard: lightboard ? { ...lightboard.state(), vocabulary: lightboard.vocabulary() } : null,
  cardreader: cardreader?.state() ?? null,
  passportreader: passportreader?.state() ?? null,
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

/** 503 rather than 404: the route exists, the driver behind it does not. */
const unavailable = (device: "lightboard" | "cardreader" | "passportreader") =>
  json({ ok: false, error: `No driver for this device in this checkout — ${absent[device] ?? "not loaded"}` }, 503);

async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const post = request.method === "POST";
  const body = async <T>(): Promise<Partial<T>> => post ? await request.json().catch(() => ({})) as Partial<T> : {};

  if (pathname === "/api/state") return json(snapshot());

  if (pathname === "/api/events") {
    return activity.eventStream(() => ({ type: "hello", ...snapshot() }));
  }

  // ---- light board ----

  if (pathname.startsWith("/api/lightboard/")) {
    if (!lightboard) return unavailable("lightboard");

    if (post && pathname === "/api/lightboard/connect") {
      // An identity from the page overrides the one this process started with; omitted, the board
      // reconnects to whatever it was configured for.
      const { usb } = await body<{ usb?: lightboardModule.Usb }>();
      return await attempt(() => lightboard.connect(usb));
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
  }

  // ---- card reader ----

  if (pathname.startsWith("/api/cardreader/")) {
    if (!cardreader) return unavailable("cardreader");

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
      const { color, blink } = await body<{ color: LedColor | "off"; blink: boolean }>();
      return await attempt(() => cardreader.setLed(color ?? "off", blink));
    }
    if (post && pathname === "/api/cardreader/led-mode") {
      const { mode } = await body<{ mode: "manual" | "automatic" }>();
      return await attempt(() => cardreader.setLedMode(mode === "automatic" ? "automatic" : "manual"));
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
    if (post && pathname === "/api/cardreader/deactivate-icc") return await attempt(() => cardreader.deactivateIcc());
    if (post && pathname === "/api/cardreader/probe") {
      const { literal } = await body<{ literal: string }>();
      return await attempt(() => cardreader.probe(literal ?? ""));
    }
    if (post && pathname === "/api/cardreader/shutter") {
      // The type comes from the type-only alias, not from `cardreader`: that name is a value here,
      // bound by the dynamic import above, so it carries no types to reach through.
      const { shutter } = await body<{ shutter: CardReaderModule.Shutter }>();
      return await attempt(() => cardreader.setShutter(shutter === "locked" ? "locked" : "unlocked"));
    }
    if (post && pathname === "/api/cardreader/arm") {
      const { outcome } = await body<{ outcome: CardReaderModule.NextOutcome }>();
      return await attempt(() => cardreader.arm(outcome ?? "card"));
    }
  }

  // ---- passport reader ----

  if (pathname.startsWith("/api/passportreader/")) {
    if (!passportreader) return unavailable("passportreader");

    if (post && pathname === "/api/passportreader/connect") return await attempt(() => passportreader.connect());
    if (post && pathname === "/api/passportreader/disconnect") return await attempt(() => passportreader.disconnect());
    if (post && pathname === "/api/passportreader/settings") {
      const next = await body<{
        lights: LightSourceName[];
        resolution: ResolutionName;
        ambientLightElimination: boolean;
        source: NonNullable<ReadMrzOptions["source"]>;
        buzzerMs: number;
      }>();
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
      const lights = passportreader.vocabulary().lights as readonly string[];
      const unknownLight = next.lights?.find((light) => !lights.includes(light));
      if (unknownLight !== undefined) return json({ ok: false, error: `unknown light source: ${unknownLight}` }, 400);
      // Checked for the same reason as the resolution: `source` picks which pair of native calls a
      // read makes, and an unrecognised one would silently fall through to the PC pair.
      if (next.source !== undefined && !known(OCR_SOURCES, next.source)) {
        return json({ ok: false, error: `unknown OCR source: ${next.source}` }, 400);
      }
      return await attempt(() => passportreader.settings(next));
    }
    if (post && pathname === "/api/passportreader/reset") return await attempt(() => passportreader.reset());
    if (post && pathname === "/api/passportreader/scan") return await attempt(() => passportreader.scan());
    // The two granular reads. Both carry document data and are answered to the caller only.
    if (post && pathname === "/api/passportreader/mrz") return await attempt(() => passportreader.readMrz());
    if (post && pathname === "/api/passportreader/barcode") return await attempt(() => passportreader.readBarcode());
    if (post && pathname === "/api/passportreader/led") {
      const { color, usage } = await body<{ color: LedColorName | "off"; usage: LedUsageName }>();
      if (usage !== undefined && !known(LED_USAGES, usage)) {
        return json({ ok: false, error: `unknown LED usage: ${usage}` }, 400);
      }
      return await attempt(() => passportreader.setLed(color ?? "off", usage));
    }
    if (post && pathname === "/api/passportreader/buzz") return await attempt(() => passportreader.buzz());
    // The one response carrying document data. It is answered to the caller and never recorded.
    if (post && pathname === "/api/passportreader/read") return await attempt(() => passportreader.read());
    if (post && pathname === "/api/passportreader/arm") {
      const { outcome } = await body<{ outcome: PassportReaderModule.NextOutcome }>();
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
      const lights = passportreader.vocabulary().lights as readonly string[];
      if (light === undefined || !lights.includes(light)) {
        return json({ ok: false, error: `unknown light source: ${light}` }, 400);
      }
      // The page never asks for an encoding — JPEG is what a full-page scan wants — but the query is
      // kept and validated, because reaching for `&format=png` by hand is exactly how someone checks
      // the driver's other two image paths on a kiosk. Under mock only BMP can be produced.
      const format = query.get("format") ?? "jpeg";
      if (!known(IMAGE_FORMATS, format)) return json({ ok: false, error: `unknown image format: ${format}` }, 400);
      const region = query.get("region") ?? "document";
      if (!known(IMAGE_REGIONS, region)) return json({ ok: false, error: `unknown image region: ${region}` }, 400);
      try {
        const scan = await passportreader.image(light as LightSourceName, format as ImageFormat, region as ImageRegion);
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
  }

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
  // Optional: a device whose driver is not in this checkout never opened a handle to release.
  await lightboard?.disconnect();
  await cardreader?.disconnect();
  await passportreader?.disconnect();
  await server.shutdown();
  Deno.exit(0);
});

await delay(0);

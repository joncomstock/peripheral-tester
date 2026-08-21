/**
 * IER S33380 light board tester — backend.
 *
 * Owns the COM port and exposes it over a local JSON + SSE API. The browser never touches the
 * board: only the process holding the COM handle can drive it, and the driver is Deno-native.
 *
 * It exists for the on-device validation the driver still needs, and for the two questions only a
 * wired board can answer:
 *  1. **What token does the board actually reply with?** The expected `SY@` / `AI@` / `AL@` come
 *     from the Python driver's source and were never confirmed on the wire. Every reply that is not
 *     the expected one is logged and reaches the page verbatim.
 *  2. **Are `payment` (channel 1) and `cardReader` (channel 2) wired as the defaults assume?**
 *     Both were `TODO`-marked as unverified, and `payment` shares channel 1 with the semaphore's
 *     green lamp — so pressing `payment` may light the semaphore instead. Watch the board, not the
 *     screen.
 *
 * ```
 * deno task dev                 # COM14
 * deno task dev COM3            # another port
 * deno task dev:mock            # no hardware
 * ```
 *
 * `--mock` drives a fake board through the real driver, so the page can be checked off-kiosk — the
 * command construction, framing and ack matching under test are the shipped ones. It answers every
 * command and reports a door every few seconds.
 *
 * @module
 */

import { delay } from "@std/async";
import { join } from "@std/path";
import { serveDir } from "@std/http/file-server";
import type { Transport } from "@eai/models";
import { ACTIONS, IER_S33380_DEFAULTS, IERS33380, INDICATOR_SECTIONS, SEMAPHORE_COLORS, SIDES, STRIP_COLORS } from "@eai/ier/s33380";
import type { LedRequest } from "@eai/ier/s33380";
import { aiCollisions } from "./collisions.ts";

const args = Deno.args.filter((a) => a !== "--mock");
const mock = Deno.args.includes("--mock");
const portName = args[0] ?? "COM14";
const port = Number(Deno.env.get("PORT") ?? 8777);

const here = import.meta.dirname;
if (here === undefined) throw new Error("run this from a checkout: the built UI is served from ./dist");
const distDir = join(here, "..", "dist");
const built = await Deno.stat(join(distDir, "index.html")).then(() => true).catch(() => false);

// ---------------------------------------------------------------------------------------------
// A fake board, for checking the page without a kiosk.
// ---------------------------------------------------------------------------------------------

/**
 * Input channels the mock reports on, taken from the default map rather than written out, so the
 * mock cannot report a channel the driver ignores.
 */
const MOCK_DOOR_CHANNELS = Object.keys(IER_S33380_DEFAULTS.doors).map(Number);

/** Answers every command with the expected token and reports a door every few seconds. */
class MockBoard implements Transport {
  isOpen = true;
  #inbound: Uint8Array[] = [];
  #enc = new TextEncoder();
  #tick = 0;

  constructor() {
    setInterval(() => {
      // Opens then closes each door in turn. Reporting only one of them would leave half the
      // channel → door map unexercised off-hardware, and that map is configuration.
      const channel = MOCK_DOOR_CHANNELS[Math.floor(this.#tick / 2) % MOCK_DOOR_CHANNELS.length];
      const state = this.#tick % 2 === 0 ? "A" : "I";
      this.#tick += 1;
      this.#inbound.push(this.#enc.encode(`\x02/L;${channel}=${state}\x03`));
    }, 4000);
  }

  write(data: Uint8Array): Promise<void> {
    // Stripped by code point, not by regex: a pattern holding the raw STX/ETX bytes evades both
    // `no-control-regex` (which only sees escape sequences) and review (they are invisible).
    const framed = new TextDecoder().decode(data);
    const start = framed.charCodeAt(0) === 0x02 ? 1 : 0;
    const end = framed.charCodeAt(framed.length - 1) === 0x03 ? framed.length - 1 : framed.length;
    const body = framed.slice(start, end);
    this.#inbound.push(this.#enc.encode(`\x02${body.slice(0, 2)}@\x03`));
    return Promise.resolve();
  }

  read(): Promise<Uint8Array | null> {
    const next = this.#inbound.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => setTimeout(() => resolve(null), 50));
  }

  readUntil(): Promise<Uint8Array | null> {
    throw new Error("the light board frames its own reads");
  }

  close(): Promise<void> {
    this.isOpen = false;
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------------------------

const board = mock ? await IERS33380.openWithTransport(new MockBoard(), undefined, "tester") : await IERS33380.open({ portName });

/** Everything the page has shown, newest last. Bounded so a long session cannot grow without end. */
const log: { at: string; kind: string; text: string }[] = [];
const listeners = new Set<(line: string) => void>();

function record(kind: string, text: string): void {
  const entry = { at: new Date().toISOString().slice(11, 23), kind, text };
  log.push(entry);
  if (log.length > 500) log.shift();
  const line = `data: ${JSON.stringify(entry)}\n\n`;
  for (const send of listeners) send(line);
}

const doors = { upper: "unknown", lower: "unknown" };

board.on("door", (event: { door: "upper" | "lower"; state: string }) => {
  doors[event.door] = event.state;
  record("door", `${event.door} door ${event.state}`);
});
board.on("data", (text: string) => record("data", text));
board.on("error", (err: Error) => record("error", err.message));
board.on("disconnect", () => record("disconnect", "the board stopped reporting; restart to reopen"));

record("open", `${mock ? "mock board" : portName} open`);

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The button grid is generated from this, so the UI cannot drift from the driver's vocabularies. */
function vocabulary() {
  return {
    portName: mock ? "mock" : portName,
    mock,
    actions: ACTIONS,
    indicators: INDICATOR_SECTIONS.map((section) => ({ section, channel: board.config.indicators[section] })),
    sides: SIDES.map((side) => ({ side, channel: board.config.bagTag[side] })),
    stripColors: STRIP_COLORS.map((color) => ({ color, channel: board.config.strip[color] })),
    semaphoreColors: SEMAPHORE_COLORS.map((color) => ({ color, channels: board.config.semaphore[color] })),
    // Computed from the live channel map, so a collision a custom `config` introduces is reported
    // the same way the shipped `payment`/semaphore-green one is.
    collisions: aiCollisions(board.config),
    // Declared, because the driver exports no "was this confirmed" flag — it is prose in its
    // `defaults.ts`. Shorten this list as a wired board confirms each channel.
    unverified: ["payment", "cardReader"],
  };
}

async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/vocabulary") return json(vocabulary());
  if (pathname === "/api/status") return json({ listening: board.isListening, doors, log });

  if (pathname === "/api/events") {
    let send: (line: string) => void;
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        send = (line) => {
          try {
            controller.enqueue(encoder.encode(line));
          }
          catch {
            listeners.delete(send);
          }
        };
        listeners.add(send);
        send(`data: ${JSON.stringify({ at: "", kind: "hello", text: "stream open" })}\n\n`);
      },
      cancel() {
        listeners.delete(send);
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  if (request.method === "POST" && (pathname === "/api/led" || pathname === "/api/all-off")) {
    try {
      if (pathname === "/api/all-off") {
        await board.allOff();
        record("sent", "allOff");
      }
      else {
        const request_ = await request.json() as LedRequest;
        await board.ledControl(request_);
        record("sent", JSON.stringify(request_));
      }
      return json({ ok: true });
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record("failed", message);
      return json({ ok: false, error: message }, 500);
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

console.log(`  IER S33380 tester — ${mock ? "MOCK board" : portName}`);
console.log(built ? `  open http://localhost:${port}/` : `  API on :${port} — UI not built, run \`npm run dev\` (:5175)`);
console.log(`  watch the BOARD as well as the page: payment and cardReader channels are unverified\n`);

const server = Deno.serve({ port, onListen: () => {} }, handle);

// Leave the board dark and the port released on Ctrl-C, so the next run can open it.
Deno.addSignalListener("SIGINT", async () => {
  console.log("\n  shutting down: darkening the board and releasing the port");
  try {
    await board.allOff();
  }
  catch { /* a board that is already unreachable cannot be darkened */ }
  await board.close();
  await server.shutdown();
  Deno.exit(0);
});

await delay(0);

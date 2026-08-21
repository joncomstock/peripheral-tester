/**
 * IER S33380 light board tester — backend.
 *
 * Owns the COM port and exposes it over a local JSON + SSE API. The browser never touches the
 * board: only the process holding the COM handle can drive it, and the driver is Deno-native.
 *
 * This is a control panel, not a probe. It drives every section of the board and reports what the
 * board says back; it does not ask the operator to grade the result. Where the channel map turns out
 * to be wrong for a given kiosk, the fix is a `config` passed to `IERS33380.open()`.
 *
 * ```
 * deno task dev                 # serves the UI; connect to a port from the page
 * deno task dev:mock            # no hardware
 * ```
 *
 * `--mock` drives a fake board through the real driver, so the page can be checked off-kiosk — the
 * command construction, framing and ack matching under test are the shipped ones.
 *
 * @module
 */

import { delay } from "@std/async";
import { join } from "@std/path";
import { serveDir } from "@std/http/file-server";
import { BaseHandler } from "@std/log";
import type { LogRecord } from "@std/log";
import { attachHandler } from "@eai/logging-ts";
import type { Transport } from "@eai/models";
import {
  ACTIONS,
  DEFAULT_PORT,
  IER_S33380_DEFAULTS,
  IERS33380,
  INDICATOR_SECTIONS,
  SEMAPHORE_COLORS,
  SIDES,
  STRIP_COLORS,
} from "@eai/ier/s33380";
import type { LedRequest } from "@eai/ier/s33380";
import { aiCollisions } from "./collisions.ts";

const args = Deno.args.filter((a) => a !== "--mock");
const mock = Deno.args.includes("--mock");
const port = Number(Deno.env.get("PORT") ?? 8777);

const here = import.meta.dirname;
if (here === undefined) throw new Error("run this from a checkout: the built UI is served from ./dist");
const distDir = join(here, "..", "dist");
const built = await Deno.stat(join(distDir, "index.html")).then(() => true).catch(() => false);

// ---------------------------------------------------------------------------------------------
// A fake board, for driving the page without a kiosk.
// ---------------------------------------------------------------------------------------------

/**
 * Answers every command with a plausible token and reports a door when asked to.
 *
 * The doors are driven from the page rather than a timer: this is a control panel, and a door that
 * flapped on its own every few seconds would fill the activity log with events nobody caused.
 */
class MockBoard implements Transport {
  isOpen = true;
  #inbound: Uint8Array[] = [];
  #enc = new TextEncoder();
  #replies = 0;

  /** Push an input report for a door channel, as the real board would when a switch moves. */
  reportDoor(channel: number, open: boolean): void {
    this.#inbound.push(this.#enc.encode(`\x02/L;${channel}=${open ? "A" : "I"}\x03`));
  }

  write(data: Uint8Array): Promise<void> {
    // Stripped by code point, not by regex: a pattern holding the raw STX/ETX bytes evades both
    // `no-control-regex` (which only sees escape sequences) and review (they are invisible).
    const framed = new TextDecoder().decode(data);
    const start = framed.charCodeAt(0) === 0x02 ? 1 : 0;
    const end = framed.charCodeAt(framed.length - 1) === 0x03 ? framed.length - 1 : framed.length;
    const body = framed.slice(start, end);
    // Every third reply echoes the parameters (`AI;3=O@`) instead of answering bare (`AI@`). Both
    // shapes are real, the driver accepts either and warns naming the token it saw, and the warning
    // reaches the activity log — so that path is exercised before anyone is standing at a kiosk.
    this.#replies += 1;
    const token = this.#replies % 3 === 0 ? body : body.slice(0, 2);
    this.#inbound.push(this.#enc.encode(`\x02${token}@\x03`));
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
// Session
// ---------------------------------------------------------------------------------------------

type Status = "closed" | "opening" | "open";

let board: IERS33380 | null = null;
let mockBoard: MockBoard | null = null;
let status: Status = "closed";
let portName = mock ? "mock" : (args[0] ?? DEFAULT_PORT);

const doors: Record<"upper" | "lower", string> = { upper: "closed", lower: "closed" };

/** Everything the page has shown, newest last. Bounded so a long session cannot grow without end. */
const log: { at: string; kind: string; text: string }[] = [];
const listeners = new Set<(line: string) => void>();

function send(payload: unknown): void {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const listener of listeners) listener(line);
}

function record(kind: string, text: string): void {
  const entry = { at: new Date().toISOString().slice(11, 19), kind, text };
  log.push(entry);
  if (log.length > 500) log.shift();
  send({ type: "log", entry });
}

function announce(): void {
  send({ type: "status", status, portName, doors });
}

/**
 * Logger names already carrying our handler.
 *
 * `attachHandler` pushes onto the logger's handler list, so reconnecting to the same port would
 * attach a second copy and every driver warning would arrive twice.
 */
const attached = new Set<string>();

/**
 * The driver's own warnings, onto the page.
 *
 * A mismatched acknowledgement is reported through the driver's logger, which means this process's
 * stdout — where an operator looking at the board and the page has no reason to be watching.
 */
class WarningsToPage extends BaseHandler {
  /** Warnings only: the driver's `error` calls already reach the page through its `error` event. */
  override handle(entry: LogRecord): void {
    if (entry.levelName === "WARN") record("warned", entry.msg);
  }

  /** Abstract on the base class, and unreachable here: `handle` never enters the formatting path. */
  override log(): void {
    throw new Error("unreachable");
  }
}

function listen(name: string): void {
  if (attached.has(name)) return;
  attachHandler(name, new WarningsToPage("WARN"));
  attached.add(name);
}

function wire(opened: IERS33380): void {
  opened.on("door", (event: { door: "upper" | "lower"; state: string }) => {
    doors[event.door] = event.state;
    record("door", `${event.door[0].toUpperCase()}${event.door.slice(1)} door ${event.state}`);
    announce();
  });
  opened.on("data", (text: string) => record("data", text));
  opened.on("error", (err: Error) => record("error", err.message));
  opened.on("disconnect", () => {
    record("error", "The board stopped reporting. Reconnect to continue.");
    board = null;
    mockBoard = null;
    status = "closed";
    announce();
  });
}

async function connect(requested: string): Promise<void> {
  if (status !== "closed") return;
  portName = mock ? "mock" : requested.trim().toUpperCase() || DEFAULT_PORT;
  status = "opening";
  announce();
  record("info", `Opening ${portName} at 9600 8N1`);

  const name = `IERS33380:${portName}`;
  try {
    if (mock) {
      mockBoard = new MockBoard();
      board = await IERS33380.openWithTransport(mockBoard, undefined, name);
    }
    else {
      board = await IERS33380.open({ portName });
    }
  }
  catch (err) {
    status = "closed";
    board = null;
    mockBoard = null;
    announce();
    record("error", err instanceof Error ? err.message : String(err));
    throw err;
  }

  listen(name);
  wire(board);
  status = "open";
  announce();
  record("ok", "Board acknowledged handshake");
}

async function disconnect(): Promise<void> {
  const open = board;
  if (!open) return;
  board = null;
  mockBoard = null;
  status = "closed";
  // Leave the board dark: a kiosk left with lamps lit is the mistake this button exists to avoid.
  try {
    await open.allOff();
  }
  catch { /* a board that is already unreachable cannot be darkened */ }
  await open.close();
  announce();
  record("info", `${portName} released`);
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

const json = (body: unknown, statusCode = 200) =>
  new Response(JSON.stringify(body), { status: statusCode, headers: { "content-type": "application/json" } });

/**
 * The board's vocabulary and channel map.
 *
 * Built from the driver's own exported arrays, so the page cannot offer a section the driver does
 * not have. Before a connection there is no live config, so the shipped defaults stand in — the
 * channel numbers are what the page labels each control with, and they are configuration either way.
 */
function vocabulary() {
  const config = board?.config ?? IER_S33380_DEFAULTS;
  return {
    mock,
    actions: ACTIONS,
    indicators: INDICATOR_SECTIONS.map((section) => ({ section, channel: config.indicators[section] })),
    sides: SIDES.map((side) => ({ side, channel: config.bagTag[side] })),
    stripColors: STRIP_COLORS.map((color) => ({ color, channel: config.strip[color] })),
    semaphoreColors: SEMAPHORE_COLORS.map((color) => ({ color, channels: config.semaphore[color] })),
    doorChannels: Object.entries(config.doors).map(([channel, door]) => ({ channel: Number(channel), door })),
    collisions: aiCollisions(config),
  };
}

/** Sections sharing an indicator channel, so a command that may drive two lamps says so once. */
function sharedNote(request: LedRequest): string | null {
  const id = request.section === "bagTagPrinter"
    ? `bagTag:${request.side}`
    : request.section === "semaphore"
    ? `semaphore:${request.color}`
    : request.section === "strip"
    ? null
    : `indicator:${request.section}`;
  if (id === null) return null;

  for (const collision of vocabulary().collisions) {
    const mine = collision.claimants.find((claimant) => claimant.id === id);
    if (!mine) continue;
    const others = collision.claimants.filter((claimant) => claimant.id !== id).map((c) => c.label);
    return `ch ${collision.channel} is also ${others.join(" and ")}`;
  }
  return null;
}

async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const post = request.method === "POST";

  if (pathname === "/api/state") {
    return json({ status, portName, mock, doors, log, vocabulary: vocabulary() });
  }

  if (pathname === "/api/events") {
    let push: (line: string) => void;
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        push = (line) => {
          try {
            controller.enqueue(encoder.encode(line));
          }
          catch {
            listeners.delete(push);
          }
        };
        listeners.add(push);
        push(`data: ${JSON.stringify({ type: "status", status, portName, doors })}\n\n`);
      },
      cancel() {
        listeners.delete(push);
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  if (post && pathname === "/api/connect") {
    const body = await request.json().catch(() => ({})) as { portName?: string };
    try {
      await connect(body.portName ?? portName);
      return json({ ok: true, status, portName });
    }
    catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  if (post && pathname === "/api/disconnect") {
    await disconnect();
    return json({ ok: true, status });
  }

  if (post && (pathname === "/api/led" || pathname === "/api/all-off")) {
    const open = board;
    if (!open) return json({ ok: false, error: "Not connected" }, 409);
    try {
      if (pathname === "/api/all-off") {
        await open.allOff();
        record("ok", "All off");
      }
      else {
        const led = await request.json() as LedRequest;
        await open.ledControl(led);
        record("sent", JSON.stringify(led));
        const note = sharedNote(led);
        if (note) record("info", note);
      }
      return json({ ok: true });
    }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record("error", message);
      return json({ ok: false, error: message }, 500);
    }
  }

  // Moving a door switch by hand is the operator's job on a real kiosk; with no kiosk in front of
  // you the page has to be able to move it instead, or the reporting path is never seen.
  if (post && pathname === "/api/door") {
    if (!mock || !mockBoard) return json({ ok: false, error: "Only a mock board has simulated doors" }, 409);
    const body = await request.json().catch(() => ({})) as { door?: "upper" | "lower" };
    const door = body.door === "lower" ? "lower" : "upper";
    const entry = vocabulary().doorChannels.find((candidate) => candidate.door === door);
    if (!entry) return json({ ok: false, error: `No input channel maps to the ${door} door` }, 409);
    mockBoard.reportDoor(entry.channel, doors[door] !== "open");
    return json({ ok: true });
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

console.log(`  IER S33380 light board tester${mock ? " — MOCK board" : ""}`);
console.log(built ? `  open http://localhost:${port}/` : `  API on :${port} — UI not built, run \`npm run dev\` (:5175)`);
console.log(`  connect to a port from the page\n`);

const server = Deno.serve({ port, onListen: () => {} }, handle);

// Leave the board dark and the port released on Ctrl-C, so the next run can open it.
Deno.addSignalListener("SIGINT", async () => {
  console.log("\n  shutting down: darkening the board and releasing the port");
  await disconnect();
  await server.shutdown();
  Deno.exit(0);
});

await delay(0);

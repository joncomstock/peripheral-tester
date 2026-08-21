# IER S33380 light board tester

A standalone **local hardware test utility** for the IER **S33380 kiosk light board**, built on the
`@eai/ier/s33380` driver. Indicator LEDs, the LED strip, the semaphore tower, and the two
service-door switches.

It is intentionally minimal — no auth, no database, no cloud. A Deno backend owns the COM port; a
React/Vite frontend drives it.

> The browser **never** talks to the board. The transport is a Win32 COM port over Deno FFI, and only
> the process holding the COM handle can drive it — so every device call goes through the backend.

```text
Browser (React/Vite)  ──/api──►  Deno backend  ──serial / Win32 FFI──►  S33380
                                      │
                                      └─ @eai/ier/s33380  (published package, unmodified)
```

## What it does

Drives every section of the board and shows what the board says back:

- **Component indicators** — payment terminal, card reader, passport reader, boarding pass printer,
  GPP dispenser. On / Blink / Off each.
- **Bag tag printer** — one indicator per side.
- **Semaphore tower** — green, red, and yellow, which is the red and green lamps lit together.
- **LED strip** — on or off per colour. The strip has no blink on the wire, so it is not offered.
- **Service doors** — reported by the board as the switches move.
- **Activity** — every command sent, every door report, and anything the board replied that the
  driver did not expect, quoted exactly as it arrived.

Pick a port, connect, and drive it. **All Off** darkens every indicator, both bag-tag sides and every
strip colour; so does disconnecting, and so does Ctrl-C on the backend, because a kiosk left with
lamps lit is the mistake worth designing against.

The lamps on screen show what was **commanded**. The board acknowledges commands and never reports
lamp state, so that is the honest thing for a control panel to show.

### The channel map is configuration

Every channel number is a property of how a given kiosk is wired, not of the protocol. The page
labels each control with the channel it drives, taken from the map in force. Two of the shipped
defaults — `payment` = 1 and `cardReader` = 2 — were never exercised on hardware, and `payment` = 1
is the same channel as the semaphore's green lamp, so commanding one may drive the other. Where a
channel is shared, the activity log says so as the command goes out. Correct a wrong map by passing
a `config` to `IERS33380.open()`.

## Quick start

Prereqs: **Deno ≥ 2.9** and **Node ≥ 18**. Built and verified on Deno 2.9.4; Node is only
needed to build the UI, not to run it.

```bash
npm install            # frontend deps (one time)
npm run build          # bundle the UI into dist/ (one time / after UI edits)

deno task dev          # serves the API and the built UI; pick a port on the page
deno task dev COM3     # prefills a port
deno task dev:mock     # no hardware
# → open http://localhost:8777/   (PORT overrides)
```

One process, because the one holding the COM handle has to be the one serving the page. The board is
not opened until you press **Connect**, so starting the backend never touches the port.

For frontend work, `npm run dev` runs Vite on `:5175` and proxies `/api` to the backend, so hot
reload works while the board stays on the Deno side (`TESTER_PORT` overrides the target).

### Before `@eai/ier` is published

`@eai/ier` is not on the registry yet — publish order is `@eai/serial`, then `@eai/ier`. Until then
nothing runs from a clean clone. To work against unlanded driver work, swap the pin in `deno.jsonc`
for a relative path into a sibling checkout:

```jsonc
"@eai/ier/s33380": "../hardware-libs/ier/s33380/mod.ts",   // changed
"@eai/serial":     "../hardware-libs/serial/mod.ts",       // added
"@eai/shared":     "../hardware-libs/shared/mod.ts",       // added
"@eai/async":      "jsr:@eai/async@^1.0.0",                // added
"@eai/hotplug":    "jsr:@eai/hotplug@^1.0.0",              // added
"@std/bytes":      "jsr:@std/bytes@^1.0.6",                // added
```

Five extra entries, not one: a relative path brings the driver's source but not the workspace import
map it resolves against, so its own bare specifiers resolve against _this_ map instead. Miss one and
the failure is a single TS2307 followed by a cascade of TS7006 implicit-anys pointing at code that is
fine — the driver's exports silently became `any`. Read the _first_ error, not the loudest ones.

Also check the path: this repo is a sibling of `elevationai/`, so hardware-libs sits at
`../elevationai/hardware-libs/…` in that layout. And delete any `deno.lock` written while swapped —
it records the local paths. **Do not commit any of it.** A clone without `hardware-libs` beside it
fails the same way, on config nobody thinks to suspect.

## Mock mode

`deno task dev:mock` runs a fake `Transport` through the **real driver**, so the command
construction, framing and ack matching being exercised are the shipped ones. It answers every
command and echoes the parameters back on every third reply (`AI;3=O@` rather than `AI;3@`) — a shape
the driver accepts and warns about, so that path is exercised before anyone is standing at a kiosk.

Its service doors are moved from the page rather than on a timer: a door that flapped on its own
would fill the activity log with events nobody caused. Those buttons appear only in mock mode.

There is deliberately no mock in the browser. A second mock would be a copy that goes stale, and a
page that can fake a board is a page that can produce a screenshot nobody should trust.

## The driver's own warnings

A mismatched acknowledgement is reported through the driver's logger, which means the backend's
stdout — where an operator looking at the board and the page has no reason to be watching. The
backend attaches a log handler so those land in **Activity** instead, quoted verbatim.

## Layout

| Path                   | What                                                              |
| ---------------------- | ----------------------------------------------------------------- |
| `server/main.ts`       | Owns the COM port. JSON + SSE API, and serves `dist/` on a kiosk. |
| `server/collisions.ts` | Which indicator channels two sections share, from the live map.   |
| `src/api.ts`           | Typed client for that API. No vocabulary of its own.              |
| `src/rows.ts`          | Payload → controls, and the naming rule the whole page uses.      |
| `src/look.ts`          | Lamps, segmented buttons and the strip preview, computed.         |
| `src/App.tsx`          | The page.                                                         |
| `src/styles.css`       | Everything static. Anything that varies lives in `look.ts`.       |

The controls are generated from `/api/state`, which the backend builds from the driver's own exported
vocabularies (`ACTIONS`, `INDICATOR_SECTIONS`, `STRIP_COLORS`, `SEMAPHORE_COLORS`, `SIDES`) and the
live channel map. Nothing here keeps its own list of sections, actions or channel numbers, so this
repo cannot disagree with the driver about what the board has. Operator-facing names are the one
exception, and a section with no name falls back to the driver's identifier so it still appears.

## Checks

```bash
deno task check && deno task test    # backend
npm test && npm run build            # frontend
```

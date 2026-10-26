# Peripheral Tester

A standalone **local hardware test utility** for the peripherals of an IER **919** kiosk. A Deno
backend owns every device handle; a React/Vite frontend drives them from a dashboard.

| Device                     | Driver            | Bus                       |
| -------------------------- | ----------------- | ------------------------- |
| Light board                | `@eai/ier/s33380` | USB bulk, libusb (WinUSB) |
| Card reader (Omron V4K)    | `@eai/omron-v4k`  | USB HID                   |
| Card reader (Sankyo ICM330)| `@eai/sankyo`     | USB HID                   |
| Passport reader            | not yet wired up  | —                         |

Every device is its own session, so any combination can be connected at once: a kiosk is tested
as a whole.

The dashboard opens on a **kiosk picker**: **IER 919** shows the light board, the Omron V4K and the
(planned) passport reader; **SITA D4** shows the Sankyo ICM330; **All Devices** shows every device,
including the rest of hardware-libs' drivers, which are listed as planned until a screen drives them.
The choice is remembered per browser. The kiosk-to-device map is `KIOSKS` in `src/Home.tsx`.

It is intentionally minimal — no auth, no database, no cloud.

> [!IMPORTANT]
> **The backend needs a `hardware-libs` master checkout beside this repo.** None of the drivers is
> published yet, so `deno.jsonc` pins their `jsr:` versions from master and `links` resolves them
> to `../elevationai/hardware-libs`. Keep that checkout on an up-to-date `master`. When the drivers
> are published, delete `links` and nothing else changes. The frontend (`npm test`,
> `npm run build`) builds as cloned.

> The browser **never** talks to hardware. The USB and USB HID handles are held by the backend, and
> only the process holding them can drive the devices.

```text
Browser (React/Vite)  ──/api──►  Deno backend  ──serial / USB HID──►  kiosk peripherals
                                       ├─ @eai/ier/s33380
                                       ├─ @eai/omron-v4k
                                       └─ @eai/sankyo
```

## What it does

Pick a device from the dashboard, connect, and drive it. Both screens are control panels rather than
probes: they drive the peripheral and report what came back. Where a channel map or a transaction
setting turns out to be wrong for a kiosk, the fix is configuration passed to the driver.

**Light board** — component indicators, bag-tag sides, the semaphore tower, and the LED strip with
its additive mixes. Service doors report as their switches move. The lamps on screen show what was
**commanded**: the board acknowledges commands and never reports lamp state.

**Card reader (V4K)** — read a card, with the transaction settings the device takes: read direction,
track mask, whether to hold the card, and how long to wait. The literal command each setting produces
is shown beside it, so what goes on the wire is visible. Shutter lock/unlock, IC contact control and
the literal probe are gone: `@eai/omron-v4k` leaves them out until their encodings are confirmed.

**Card reader (Sankyo)** — read one card (Intake, then the tracks the reader holds), or listen through
the driver's polling monitor, which reports the card going in and out. Bezel LED and identity too.

On Windows the light board must be bound to **WinUSB** (Zadig, or hardware-libs' binding script), not
IER's `ierVBus` COM driver; on macOS it needs `brew install libusb`.

### Cardholder data

Both card reader drivers return an **unmasked PAN** and the raw stripe, because truncation policy belongs to
whoever knows which scheme applies. This tester's policy:

- The PAN and the stripe are **never logged or stored**, server-side or client-side. The activity log
  records that a card was read and which tracks decoded, nothing more.
- The screen masks to the last four by default. Revealing is deliberate, and resets on the next read.
- A read's card data exists only in the reply to the read that produced it.

## Quick start

Prereqs: **Deno ≥ 2.9** and **Node ≥ 18**, on the kiosk as well as a dev machine — the UI is built
where it runs. Built and verified on Deno 2.9.4.

`dist/` is gitignored, so **`git pull` never updates the built UI**. Build after every pull: the page
and the backend talk to each other, and an old bundle against a new backend shows wrong values rather
than failing loudly.

```bash
npm install            # frontend deps (one time)
npm run build          # bundle the UI into dist/ (one time / after UI edits)

deno task dev          # serves the API and the built UI
deno task dev:mock     # no hardware
# → open http://localhost:8777/   (PORT overrides)
```

One process, because the one holding the device handles has to be the one serving the page. Nothing
is opened until you press **Connect**, so starting the backend never touches a device. (Importing the
drivers starts `@eai/hotplug`, which under `dev:mock` prints a libusb/FFI warning; it is harmless.)

For frontend work, `npm run dev` runs Vite on `:5175` and proxies `/api` to the backend, so hot
reload works while the board stays on the Deno side (`TESTER_PORT` overrides the target).

## Mock mode

`deno task dev:mock` runs fake transports through the **real drivers**, so the command
construction, framing and ack matching being exercised are the shipped ones. It answers every
command and echoes the parameters back on every third reply (`AI;3=O@` rather than `AI;3@`) — a shape
the driver accepts and warns about, so that path is exercised before anyone is standing at a kiosk.

The V4K mock speaks the reader's own message protocol — `C00`, `C6s`, `C:6`, `C92`, `C6a` and their
`P`/`N` replies — so the driver's framing, echo matching and track parsing are the ones under test.
What the next read produces (a card, a timeout, an unreadable stripe) is chosen from the page; once
used, the reader waits for a card that never comes, until armed again.

The Sankyo mock speaks the ICM330's packetised protocol, and its card is inserted and removed from the
page, so the monitor sees it arrive and leave as it would on a kiosk.

The light board's service doors are moved from the page rather than on a timer: a door that flapped on its own
would fill the activity log with events nobody caused. Those buttons appear only in mock mode.

There is deliberately no mock in the browser. A second mock would be a copy that goes stale, and a
page that can fake a board is a page that can produce a screenshot nobody should trust.

## The driver's own warnings

A mismatched acknowledgement is reported through the driver's logger, which means the backend's
stdout — where an operator looking at the board and the page has no reason to be watching. The
backend attaches a log handler so those land in **Activity** instead, quoted verbatim.

## Layout

| Path                        | What                                                            |
| --------------------------- | --------------------------------------------------------------- |
| `server/main.ts`            | HTTP routing, and serves `dist/` on a kiosk.                    |
| `server/activity.ts`        | The shared log and event stream. Carries no cardholder data.    |
| `server/lightboard.ts`      | The light board session. Owns its USB interface.                |
| `server/cardreader.ts`      | The Omron V4K session. Owns its USB HID handle.                 |
| `server/sankyo.ts`          | The Sankyo ICM330 session. Owns its USB HID handle.             |
| `server/devices.test.ts`    | All three mock devices connected and driven at once.            |
| `server/collisions.ts`      | Which indicator channels two sections share, from the live map. |
| `src/App.tsx`               | The shell: which device is on screen, and the shared state.     |
| `src/Home.tsx`              | The dashboard.                                                  |
| `src/LightBoardPage.tsx`    | The light board's screen and header controls.                   |
| `src/CardReaderPage.tsx`    | The V4K's screen and header controls, and the shared card panel. |
| `src/SankyoPage.tsx`        | The Sankyo's screen and header controls.                        |
| `src/Activity.tsx`          | The log panel, filtered to the device on screen.                |
| `src/lightboardControls.ts` | Vocabulary → controls, and the naming rule the page uses.       |
| `src/look.ts`               | Lamps, segmented buttons and the strip preview, computed.       |
| `src/styles.css`            | Everything static. Anything that varies lives in `look.ts`.     |

The light board's controls are generated from `/api/state`, which the backend builds from the
driver's own exported vocabularies (`ACTIONS`, `INDICATOR_SECTIONS`, `STRIP_COLORS`, `STRIP_MIX`,
`SEMAPHORE_COLORS`, `SIDES`) and the live channel map. Nothing here keeps its own list of sections, actions or channel numbers, so this
repo cannot disagree with the driver about what the board has. Operator-facing names are the one
exception, and a section with no name falls back to the driver's identifier so it still appears.

## Checks

```bash
deno task check && deno task test    # backend
npm test && npm run build            # frontend
```

# Peripheral Tester

A standalone **local hardware test utility** for the peripherals of an IER **919** kiosk. A Deno
backend owns every device handle; a React/Vite frontend drives them from a dashboard.

| Device          | Driver            | Bus               |
| --------------- | ----------------- | ----------------- |
| Light board     | `@eai/ier/s33380` | RS-232, Win32 FFI |
| Card reader     | `@eai/omron/v4ku` | USB HID           |
| Passport reader | not yet wired up  | —                 |

It is intentionally minimal — no auth, no database, no cloud.

> [!IMPORTANT]
> **This revision does not build from a clean clone.** None of the four packages it needs —
> `@eai/ier`, `@eai/serial`, `@eai/omron`, `@eai/hid` — is published, and they sit on two unmerged
> `hardware-libs` branches. Building, testing or running the backend today needs the local import
> substitutions in [Before the drivers are published](#before-the-drivers-are-published). The
> frontend (`npm test`, `npm run build`) is unaffected and builds as cloned.
>
> What removes the caveat, in order: land `feat/hid-facepod` (PR #55), land `feat/omron-v4ku` and
> `feat/ier-lightboard` — neither has a PR yet — then publish `@eai/hid` and `@eai/serial` before
> `@eai/omron` and `@eai/ier`, which depend on them. The pins here already name the versions that
> release should produce, so nothing in this repo changes when it happens.

> The browser **never** talks to hardware. A COM handle and a USB HID handle are held by the backend,
> and only the process holding them can drive the devices.

```text
Browser (React/Vite)  ──/api──►  Deno backend  ──serial / USB HID──►  kiosk peripherals
                                       ├─ @eai/ier/s33380
                                       └─ @eai/omron/v4ku
```

## What it does

Pick a device from the dashboard, connect, and drive it. Both screens are control panels rather than
probes: they drive the peripheral and report what came back. Where a channel map or a transaction
setting turns out to be wrong for a kiosk, the fix is configuration passed to the driver.

**Light board** — component indicators, bag-tag sides, the semaphore tower, and the LED strip with
its additive mixes. Service doors report as their switches move. The lamps on screen show what was
**commanded**: the board acknowledges commands and never reports lamp state.

**Card reader** — read a card, with the transaction settings the device takes: read direction, track
mask, whether to hold the card, and how long to wait. The literal command each setting produces is
shown beside it, so what goes on the wire is visible.

### Cardholder data

`@eai/omron` returns an **unmasked PAN** and the raw stripe, because truncation policy belongs to
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

deno task dev          # serves the API and the built UI; pick a port on the page
deno task dev COM3     # prefills a port
deno task dev:mock     # no hardware
# → open http://localhost:8777/   (PORT overrides)
```

One process, because the one holding the COM handle has to be the one serving the page. The board is
not opened until you press **Connect**, so starting the backend never touches the port.

For frontend work, `npm run dev` runs Vite on `:5175` and proxies `/api` to the backend, so hot
reload works while the board stays on the Deno side (`TESTER_PORT` overrides the target).

### Before the drivers are published

Neither driver is on the registry yet, and they currently live on **different unmerged branches** of
`hardware-libs` — `@eai/ier` and `@eai/serial` on `feat/ier-lightboard`, `@eai/omron` and `@eai/hid`
on `feat/omron-v4ku`. Until both land on master, a clean clone cannot build, and pointing at a single
checkout is not enough: one of the two branches has to be a second worktree.

```bash
cd hardware-libs
git worktree add --detach ../wt-ier-driver origin/feat/ier-lightboard
```

Then swap the pins in `deno.jsonc` for relative paths — the light board pair at the worktree, the
card reader pair at whichever checkout holds `feat/omron-v4ku` — plus the shared deps those drivers
resolve through this map rather than their own workspace: `@eai/shared`, `@eai/usb`, `@eai/async`,
`@eai/hotplug`, `@std/bytes` and `@std/encoding`.

Miss one and the failure is a single TS2307 followed by a cascade of TS7006 implicit-anys pointing at
code that is fine — the driver's exports silently became `any`. Read the _first_ error, not the
loudest ones. Delete any `deno.lock` written while swapped, and **do not commit any of it**.

## Mock mode

`deno task dev:mock` runs fake transports through the **real drivers**, so the command
construction, framing and ack matching being exercised are the shipped ones. It answers every
command and echoes the parameters back on every third reply (`AI;3=O@` rather than `AI;3@`) — a shape
the driver accepts and warns about, so that path is exercised before anyone is standing at a kiosk.

The card reader's mock speaks the V4KU's own report protocol — `C00`, `C6s`, `C:6`, `C92`, `C6a` and
their `P`/`N` replies — so the driver's framing, echo matching and track parsing are the ones under
test. What the next read produces (a card, a timeout, an unreadable stripe) is chosen from the page.

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
| `server/lightboard.ts`      | The light board session. Owns the COM port.                     |
| `server/cardreader.ts`      | The card reader session. Owns the USB HID handle.               |
| `server/collisions.ts`      | Which indicator channels two sections share, from the live map. |
| `src/App.tsx`               | The shell: which device is on screen, and the shared state.     |
| `src/Home.tsx`              | The dashboard.                                                  |
| `src/LightBoardPage.tsx`    | The light board's screen and header controls.                   |
| `src/CardReaderPage.tsx`    | The card reader's screen and header controls.                   |
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

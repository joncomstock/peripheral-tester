# Peripheral Tester

A standalone **local hardware test utility** for the peripherals of an IER **919** kiosk. A Deno
backend owns every device handle; a React/Vite frontend drives them from a device rail.

| Device          | Driver             | Bus                        |
| --------------- | ------------------ | -------------------------- |
| Light board     | `@eai/ier/s33380`  | RS-232, Win32 FFI          |
| Card reader     | `@eai/omron/v4ku`  | USB HID                    |
| Passport reader | `@eai/desko/penta` | USB, `PageScanAPI.dll` FFI |

It is intentionally minimal — no auth, no database, no cloud.

> [!IMPORTANT]
> **This revision does not build from a clean clone.** None of the five packages it needs —
> `@eai/ier`, `@eai/serial`, `@eai/omron`, `@eai/hid`, `@eai/desko` — is published, and they sit on
> three unmerged `hardware-libs` branches. Building, testing or running the backend today needs the
> local import substitutions in [Before the drivers are published](#before-the-drivers-are-published).
> The frontend (`npm test`, `npm run build`) is unaffected and builds as cloned.
>
> What removes the caveat, in order: land `feat/hid-facepod` (PR #55), land `feat/omron-v4ku`,
> `feat/ier-lightboard` and `feat/desko-penta` — none has a PR yet — then publish `@eai/hid` and
> `@eai/serial` before `@eai/omron` and `@eai/ier`, which depend on them. `@eai/desko` depends on
> neither and can go at any point. The pins here already name the versions that release should
> produce, so nothing in this repo changes when it happens.

> The browser **never** talks to hardware. A COM handle and a USB HID handle are held by the backend,
> and only the process holding them can drive the devices.

```text
Browser (React/Vite)  ──/api──►  Deno backend  ──serial / USB HID / FFI──►  kiosk peripherals
                                       ├─ @eai/ier/s33380
                                       ├─ @eai/omron/v4ku
                                       └─ @eai/desko/penta
```

## What it does

Pick a device from the rail, connect, and drive it. Every screen is a control panel rather than a
probe: it drives the peripheral and reports what came back. Where a channel map or a transaction
setting turns out to be wrong for a kiosk, the fix is configuration passed to the driver.

**Choose the devices first.** A bench is one kiosk at a time, and `hardware-libs` has drivers for
more peripherals than any single unit fits, so the rail carries a chosen subset rather than the
whole catalogue. The picker opens by itself on a first landing and lives behind the settings gear
after that: pick the kiosk in front of you — IER 919, Embross V1, SITA D4, NCR Touchport 120 — and
its devices are ticked for you, or tick your own set, down to one. A preset that ticks fewer boxes
than that kiosk has devices says which of its components `hardware-libs` has no driver for, so a
short list reads as the state of the catalogue rather than as a bug. Every tick applies to the rail
immediately; there is no OK and no Cancel. The choice is kept per machine, like the theme.

The rail lists the chosen devices, including any whose driver exists in `hardware-libs` but whose
tester screen is not built — knowing what a kiosk has is worth more to someone standing at one than
a shorter list, and each says which package covers it. The health sweep and the **Bus** tab follow
the rail: a device you took off it is never opened.

**Light board** — component indicators, bag-tag sides, the semaphore tower, and the LED strip with
its additive mixes. Service doors report as their switches move. The lamps on screen show what was
**commanded**: the board acknowledges commands and never reports lamp state.

**Card reader** — read a card once or listen cycle after cycle, with the transaction settings the
device takes: read direction, track mask, whether to hold the card, and how long to wait. The bezel
LED and the shutter are driven directly. The literal command each setting produces is shown beside
it, so what goes on the wire is visible.

**Passport reader** — scan a document and read what is on it: the machine-readable zone parsed into
fields with every ICAO check digit verified, any 1D or 2D barcode, and the scanned page under each
light source the unit has. `Read document` does all three under one driver lock; `Scan`, `Read MRZ`
and `Read barcode` are the same calls one at a time, because a scan that produced an image but no
MRZ and a recognition that failed on a good scan are different faults. The light, resolution,
ambient-light and OCR-source settings are the ones the next scan will use. Controls a unit cannot
honour are not offered — a scanner without the UV lamp says so, and the ultraviolet option is then
absent rather than dead.

**The keyboard** — `1`–`9` open a device from the rail, in the order it lists them, `[` collapses
it, `Enter` fires whichever action
the open screen draws as primary, `Esc` closes whatever is on top, and `?` lists all of it. No
modifiers: this is driven one-handed while the other hand holds a card. The theme, the rail and the
device you were on are remembered, because a kiosk reloads whenever anyone restarts the backend.

**Health sweep** — opens and handshakes every wired device _on the rail_ in turn without driving it,
and reports what each said for itself. It uses the same `connect` the screens do, so a pass means
the handle was genuinely claimed. A device you already have open is left open. The **Bus** tab lists what the
handshake found.

### Cardholder and document data

`@eai/omron` returns an **unmasked PAN** and the raw stripe, because truncation policy belongs to
whoever knows which scheme applies. `@eai/desko` returns an **MRZ** — a name, a nationality, a date
of birth and a document number — and the scanned page, portrait included. Both get the same policy:

- None of it is **ever logged or stored**, server-side or client-side. The activity log records that
  a card or document was read and how it decoded, nothing more. The scan is served to the tab that
  asked for it and never written to disk.
- The screen masks by default — the card's PAN to its last four, the document's number and date of
  birth likewise, and both blanked inside the raw stripe or MRZ lines that carry them inline.
  Revealing is deliberate, and resets on the next read.
- A read's data exists only in the reply to the read that produced it. There is no session history
  of past reads, and **Export JSON** exports the activity log, which the backend guarantees carries
  none of this — never a read's contents.

## Quick start

Prereqs: **Deno ≥ 2.9** and **Node ≥ 18**, on the kiosk as well as a dev machine — the UI is built
where it runs. Built and verified on Deno 2.9.4.

The passport reader additionally needs DESKO's PENTA driver package installed, so `PageScanAPI.dll`
resolves through `PATH`; set `DESKO_PAGESCAN_DLL_PATH` to point somewhere else. It is Windows x64
only, and the other two devices work without it.

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

Until the drivers publish, the `deno task` forms cannot resolve them — use the `-c
deno.local.jsonc` commands in [Before the drivers are published](#before-the-drivers-are-published)
instead. `npm` is unaffected either way.

One process, because the one holding the COM handle has to be the one serving the page. The board is
not opened until you press **Connect**, so starting the backend never touches the port.

For frontend work, `npm run dev` runs Vite on `:5175` and proxies `/api` to the backend, so hot
reload works while the board stays on the Deno side (`TESTER_PORT` overrides the target).

### Before the drivers are published

No driver is on the registry yet, and they live on **three unmerged branches** of `hardware-libs` —
`@eai/ier` and `@eai/serial` on `feat/ier-lightboard`, `@eai/omron` and `@eai/hid` on
`feat/omron-v4ku`, `@eai/desko` on `feat/desko-penta`. Until they land on master a clean clone
cannot build, and pointing at a single checkout is not enough: two of the three branches have to be
worktrees.

```bash
cd hardware-libs
git worktree add --detach ../wt-ier-driver   origin/feat/ier-lightboard
git worktree add --detach ../wt-desko-penta  origin/feat/desko-penta
```

Then write a `deno.local.jsonc` beside `deno.jsonc` and pass it with `-c`. **Do not edit
`deno.jsonc`.** An earlier revision of this section said to swap the pins in place, and
facepod-tester is what that advice produced: the swap was committed, and a clone without
`hardware-libs` beside it failed with `TS2307`. `deno.local.jsonc` is gitignored, so the same
mistake cannot be made twice.

A config passed with `-c` **replaces** `deno.jsonc` rather than merging with it, so this file
carries the whole map — the published pins as well as the swapped ones. It needs no `tasks`, `fmt`
or `lint`: the commands below invoke Deno directly, which is the point.

```jsonc
{
  "imports": {
    // The three drivers, at the branches above. Adjust the paths to your layout.
    "@eai/ier/s33380": "../wt-ier-driver/ier/s33380/mod.ts",
    "@eai/serial": "../wt-ier-driver/serial/mod.ts",
    "@eai/omron/v4ku": "../hardware-libs/omron/v4ku/mod.ts",
    "@eai/hid": "../hardware-libs/hid/mod.ts",
    "@eai/desko/penta": "../wt-desko-penta/desko/penta/mod.ts",
    // The deps those drivers resolve through this map rather than their own workspace.
    "@eai/shared": "../hardware-libs/shared/mod.ts",
    "@eai/usb": "../hardware-libs/usb/mod.ts",
    "@eai/hotplug": "../hardware-libs/hotplug/mod.ts",
    "@eai/async": "jsr:@eai/async@^1.0.0",
    "@std/bytes": "jsr:@std/bytes@^1",
    "@std/encoding": "jsr:@std/encoding@^1",
    // Unchanged from `deno.jsonc`, and required because `-c` replaces it wholesale.
    "@eai/models": "jsr:@eai/models@^1.3.0",
    "@eai/logging-ts": "jsr:@eai/logging-ts@^2.6.0",
    "@std/async": "jsr:@std/async@^1.0.0",
    "@std/path": "jsr:@std/path@^1.0.0",
    "@std/http/file-server": "jsr:@std/http@^1/file-server",
    "@std/log": "jsr:@std/log@^0.224.0",
    "@std/assert": "jsr:@std/assert@^1.0.14"
  }
}
```

`deno task` reads `deno.jsonc` and will not see this file, so run the four backend commands
directly while swapped:

```bash
deno run -c deno.local.jsonc --allow-ffi --allow-net --allow-env --allow-read server/main.ts
deno run -c deno.local.jsonc --allow-net --allow-env --allow-read server/main.ts --mock
deno check -c deno.local.jsonc server/main.ts
deno test  -c deno.local.jsonc --allow-read server/
```

`deno fmt` and `deno lint` are unaffected — they never resolve an import — so those two stay as
`deno fmt` and `deno lint` against the committed config.

`@eai/desko` is the cheapest of the three to swap: it pulls in only `@eai/async` beyond what is
already pinned here, because its native layer is behind an injectable symbol table rather than a
USB stack.

Miss an entry and the failure is a single TS2307 followed by a cascade of TS7006 implicit-anys
pointing at code that is fine — the driver's exports silently became `any`. Read the _first_ error,
not the loudest ones. Delete any `deno.lock` written while swapped; it pins resolutions that do not
exist for anybody else.

## Mock mode

`deno task dev:mock` runs fake transports through the **real drivers**, so the command
construction, framing and ack matching being exercised are the shipped ones. It answers every
command and echoes the parameters back on every third reply (`AI;3=O@` rather than `AI;3@`) — a shape
the driver accepts and warns about, so that path is exercised before anyone is standing at a kiosk.

The card reader's mock speaks the V4KU's own report protocol — `C00`, `C6s`, `C:6`, `C92`, `C6a` and
their `P`/`N` replies — so the driver's framing, echo matching and track parsing are the ones under
test. What the next read produces (a card, a timeout, an unreadable stripe) is chosen from the page.

The passport reader's mock is **shipped by its driver** rather than written here: `@eai/desko`
exports the fake `PageScanAPI.dll` symbol table its own tests run against, so this app exercises the
real struct packing and the real MRZ and barcode decoding rather than a second imitation that would
drift the moment the driver was corrected. The MRZ it returns is the ICAO 9303 specimen passport,
with its real check digits; what the next scan produces (a clean passport, a smudged MRZ, no MRZ, a
boarding pass) is chosen from the page. The scanned page it returns is a flat tint with diagonal
banding — deliberately nothing like a document, for the same reason there is no mock in the browser.

The light board's service doors are moved from the page rather than on a timer: a door that flapped on its own
would fill the activity log with events nobody caused. Those buttons appear only in mock mode.

There is deliberately no mock in the browser. A second mock would be a copy that goes stale, and a
page that can fake a board is a page that can produce a screenshot nobody should trust.

## The driver's own warnings

A mismatched acknowledgement is reported through the driver's logger, which means the backend's
stdout — where an operator looking at the board and the page has no reason to be watching. The
backend attaches a log handler so those land in **Activity** instead, quoted verbatim.

## Layout

| Path                         | What                                                              |
| ---------------------------- | ----------------------------------------------------------------- |
| `server/main.ts`             | HTTP routing, and serves `dist/` on a kiosk.                      |
| `server/activity.ts`         | The shared log and event stream. Carries no cardholder data.      |
| `server/lightboard.ts`       | The light board session. Owns the COM port.                       |
| `server/cardreader.ts`       | The card reader session. Owns the USB HID handle.                 |
| `server/passportreader.ts`   | The passport reader session. Owns the loaded `PageScanAPI.dll`.   |
| `server/collisions.ts`       | Which indicator channels two sections share, from the live map.   |
| `src/api.ts`                 | The wire contract: every type and every call the page makes.      |
| `src/main.tsx`               | The entry point, and the self-hosted fonts.                       |
| `src/App.tsx`                | The shell: which device is on screen, and the shared state.       |
| `src/ui.tsx`                 | The connection strip, the card, and the rows they are built of.   |
| `src/devices.ts`             | The driver catalogue, the kiosk presets, and which have a screen. |
| `src/DevicePicker.tsx`       | Choosing which of the catalogue the rail carries.                 |
| `src/Rail.tsx`               | The device rail.                                                  |
| `src/Planned.tsx`            | The pane for a peripheral with a driver but no screen yet.        |
| `src/LightBoardPage.tsx`     | The light board's screen and connection strip.                    |
| `src/CardReaderPage.tsx`     | The card reader's screen and connection strip.                    |
| `src/PassportReaderPage.tsx` | The passport reader's screen and connection strip.                |
| `src/Drawer.tsx`             | The side drawer: Activity and Bus.                                |
| `src/Activity.tsx`           | The log, with its scope and issues filters.                       |
| `src/sweep.ts`               | The health sweep, over the same `connect` the screens use.        |
| `src/Toasts.tsx`             | Transient confirmations for effects that are off screen.          |
| `src/prefs.ts`               | Theme, rail, chosen devices and open device, per machine.         |
| `src/dialog.ts`              | Focus trap and focus return, shared by every overlay.             |
| `src/pending.ts`             | Which commands are in flight, so a control can say it is busy.    |
| `src/download.ts`            | JSON export. Activity only — never a read's contents.             |
| `src/lightboardControls.ts`  | Vocabulary → controls, and the naming rule the page uses.         |
| `src/format.ts`              | Display formatting shared by the screens.                         |
| `src/look.ts`                | Lamps, segmented buttons and the strip preview, computed.         |
| `src/styles.css`             | Everything static, and the light and dark tokens.                 |

The light board's controls are generated from `/api/state`, which the backend builds from the
driver's own exported vocabularies (`ACTIONS`, `INDICATOR_SECTIONS`, `STRIP_COLORS`, `STRIP_MIX`,
`SEMAPHORE_COLORS`, `SIDES`) and the live channel map. Nothing here keeps its own list of sections, actions or channel numbers, so this
repo cannot disagree with the driver about what the board has. Operator-facing names are the one
exception, and a section with no name falls back to the driver's identifier so it still appears.

## Checks

```bash
deno task check && deno task test    # backend
npm test && npm run build            # frontend
deno fmt --check && deno lint        # both, and unaffected by the driver pins
```

Read the exit code, not the last line: `deno lint` prints what it found _before_ `Checked N files`,
so a tail of a failing run looks clean.

Until the drivers publish, the two `deno task` forms cannot resolve them. Swapped, they are:

```bash
deno check -c deno.local.jsonc server/main.ts && deno test -c deno.local.jsonc --allow-read server/
```

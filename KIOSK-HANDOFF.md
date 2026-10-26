# Handoff: test the peripheral tester on an IER 919

You are a Claude session running **on an IER 919 kiosk** (Windows). Your job is to set this repo up,
drive its web UI with **Playwright**, and check every function against the kiosk's real
peripherals. Then write up what you found. A human operator is standing at the kiosk. They are your
eyes on the hardware and your hands for anything physical.

Read this whole file before doing anything. Then read `README.md`.

## What you are testing

`peripheral-tester` is a local control panel for kiosk peripherals. A Deno backend holds every
device handle. A React page served by that backend drives the devices through `/api`. It was just
ported from unmerged hardware-libs branches to **hardware-libs `master`**, and that port has only
been tested against mock devices, never real hardware. That is the gap you are closing.

On the 919, the devices you can test for real are:

| Device       | Driver (hardware-libs master)  | USB id      | How it connects                       |
| ------------ | ------------------------------ | ----------- | ------------------------------------- |
| Light board  | `@eai/ier/s33380` 1.2.3        | `171c:00a0` | USB bulk through **libusb**, WinUSB   |
| Card reader  | `@eai/omron-v4k` 1.2.2         | `0590:0034` | USB HID through **hidapi**            |

The Sankyo ICM330 page belongs to the SITA D4, not the 919. Test it in **mock mode only**. The
passport reader and the other hardware-libs devices appear as "Planned" tiles and do nothing yet.

What changed in the port, so you know what is new and riskiest:

- The light board now talks USB through libusb instead of a COM port. There is no port picker.
- The card reader driver is a different driver. Shutter lock, IC contact control and the literal
  probe were **deliberately removed**, so their absence is not a bug. "Listen" is now a loop of
  read cycles in the tester (`server/cardreader.ts`) instead of the driver's own.
- The dashboard has a kiosk picker: **IER 919**, **SITA D4**, **All Devices**.

## Rules

1. **Card data.** Use test cards only. Never log, paste, commit or report a PAN, a name off a card or
   a raw stripe. Mask anything you quote, for example `•••• 1111`. Do not take a screenshot while
   "Reveal PAN" is on. If you need a screenshot of a read, take it masked.
2. **Ask the operator before anything that changes the kiosk.** That covers driver binding, stopping
   the kiosk's own application, installing software, and rebooting. Say what you will do and how to
   undo it, then wait for a yes.
3. **Physical observations come from the operator.** Playwright sees the page, not the lamps. For
   every command that should change the hardware, ask the operator what they saw. Record their exact
   answer. Do not infer it from the page: the page shows what was *commanded*, never what lit.
4. **Do not modify `hardware-libs`.** If a driver is wrong, record it as a finding with the evidence.
5. **Leave the kiosk dark.** Disconnect every device when you finish (disconnecting turns its lamps
   off), stop the backend, and tell the operator what state you left the drivers in.

## 1. Set up

### Prerequisites

- **Deno ≥ 2.9** (`deno --version`), **Node ≥ 18**, **git**.
- **Playwright.** Prefer a Playwright MCP server if your session has one. Otherwise use
  `npx playwright` from a scratch folder and run `npx playwright install chromium` once.

### Folder layout (this matters)

`deno.jsonc` uses `"links": ["../elevationai/hardware-libs"]` to resolve the unpublished drivers.
Both repos must therefore sit under one parent folder, like this:

```text
<parent>\peripheral-tester\              ← this repo
<parent>\elevationai\hardware-libs\      ← hardware-libs, on master
```

```powershell
cd <parent>
git clone https://github.com/joncomstock/peripheral-tester.git
cd peripheral-tester
git checkout hardware-libs-master
cd ..
mkdir elevationai
git clone https://github.com/elevationai/hardware-libs.git elevationai\hardware-libs
```

hardware-libs must be on **`master`**. If a newer master breaks the build, record the commit you
tested (`git -C ..\elevationai\hardware-libs log -1 --oneline`). This repo was verified against
`96967a6`.

### Native libraries

Under `deno run` on Windows, the drivers load their DLLs as follows:

- **libusb (light board).** It loads `libusb-1.0.dll` **only from the working directory**, which
  means the `peripheral-tester` folder, or from the path in `LIBUSB_PATH`. Get the x64 DLL from
  the libusb release at https://libusb.info (`VS2022\MS64\dll\libusb-1.0.dll` or similar).
- **hidapi (card reader).** It loads `hidapi.dll` from the DLL search path, or from `HIDAPI_PATH`.
  Get the x64 DLL from https://github.com/libusb/hidapi/releases.

Putting both DLLs in the `peripheral-tester` folder is simplest. `*.dll` is gitignored.

### Light board driver binding (ask first, see rule 2)

The light board only opens if its USB interface is bound to **WinUSB**. On a 919 it is usually
bound to IER's **`ierVBus`** driver instead, which presents a COM port. While that is the case, the
board never answers. Expect an `open()`/handshake failure in Activity.

- Check in Device Manager: "919 Carte Automate", `USB\VID_171C&PID_00A0`.
- Binding with **Zadig**: Options → List All Devices → pick the `171C 00A0` interface → WinUSB →
  Replace Driver.
- **This can break the kiosk's production software**, which expects the COM port. To undo:
  Device Manager → the device → Driver → Roll Back Driver (or Update Driver → the IER driver).
  Tell the operator this before they agree.

The card reader is a standard HID device and needs no binding.

### The kiosk's own software

The production application may already hold the light board or the card reader. Then opening fails,
for example as "busy", "access denied", or a reader that never answers. Ask the operator to stop it
for the duration of the test.

### Build and start

```powershell
cd <parent>\peripheral-tester
npm install
npm run build              # dist/ is gitignored: build after every pull
deno task check            # first error only: TS2307 means the links path or layout is wrong
deno task test             # 7 backend tests, including all three mock devices at once
npm test                   # 19 frontend tests
```

Under `deno task dev:mock`, `@eai/hotplug` prints a libusb/FFI warning at startup. It is harmless.

## 2. Mock pass (no hardware touched)

Do this first. It proves the setup and the UI before any real device is involved.

```powershell
deno task dev:mock         # http://localhost:8777/  (set PORT to change it)
```

Run it in the background and keep its stdout. Drive the page with Playwright, using accessibility
snapshots to find controls rather than CSS selectors. Check each of these:

**Dashboard**

- [ ] Settings → Mock devices is On, and the header shows a **MOCK** badge on every screen. Off is
      disabled under `dev:mock` (no FFI permission). Under `deno task dev` it switches both ways,
      and switching disconnects any connected device first.

- [ ] Opens on **IER 919** (first visit) showing Light Board, Card Reader (Hitachi-Omron V4K) and
      Passport Reader (Planned, disabled).
- [ ] **SITA D4** shows only Card Reader (Sankyo ICM330). **All Devices** shows 16 tiles.
- [ ] The header subtitle follows the picked kiosk. The choice survives a page reload.

**Light board (mock)**

- [ ] Connect, then Activity shows "Board acknowledged handshake".
- [ ] Every indicator, bag tag side, semaphore colour and strip colour accepts its actions. Strip
      colours are exclusive, so turning one on replaces the previous one.
- [ ] Some acks echo parameters (`AI;3=O@`), and the driver's warning appears in Activity. This is
      expected in mock mode.
- [ ] Service doors: "Simulate switch" toggles each door, and Activity reports it.
- [ ] All Off, then Disconnect.

**Card reader V4K (mock)**

- [ ] Connect, Read once, card panel: PAN masked to the last four, name and expiry shown, tracks
      "decoded". Reveal/Mask works (no screenshot while revealed).
- [ ] Mock reader → Timeout, then Read once gives "No card arrived". Unreadable, then Read once gives
      the unreadable verdict. With nothing armed, a read waits, and **Cancel** ends it as "Read
      cancelled".
- [ ] Listen, then arm Card: the card appears. Stop listening returns promptly (within about 2s),
      even when clicked right after Listen.
- [ ] Transaction settings change the literal shown in the card header (`C:6…`). Track pairs map to
      wire digits 4/5/6, for example tracks 1+2 give `C:624..`.
- [ ] Wait ±5s changes `C92xx`. LED colours, Off, Blink, and LED control Manual/Automatic all
      accepted. A colour while in Automatic switches back to Manual.
- [ ] Device → Identity → Read shows version/serial/status.

**Card reader Sankyo (mock, SITA D4)**

- [ ] Connect, Read once, then Mock reader "Insert card" within the wait: the card is read.
- [ ] Remove the card. Listen, then Insert: the header shows "Card in slot", and the card appears.
      Remove shows "Slot empty". Stop listening.
- [ ] Read once with no insert, then Cancel gives "Read cancelled". LED colours/Blink, and Identity
      reads.

**All at once**

- [ ] Connect the light board, the V4K and the Sankyo together. The dashboard shows all three
      Connected (use All Devices). Operating one never disturbs the others, and Activity on the
      dashboard tags each line `board` / `v4k` / `sankyo`.
- [ ] Ctrl-C the backend: it releases every device and exits.

## 3. Real hardware pass (IER 919)

Stop the mock backend. Start the real one, and check that Settings → Mock devices is **Off** and
no MOCK badge shows. A page in mock mode during this pass would make every result meaningless:

```powershell
deno task dev              # needs the DLLs and the WinUSB binding from section 1
```

For each check, record **what the page did**, **what Activity said**, and **what the operator saw**.

**Light board**

- [ ] Connect, then "Board acknowledged handshake". If this fails, see Troubleshooting before
      going further.
- [ ] Each component indicator (payment, card reader, passport reader, boarding pass printer, GPP
      dispenser): On, Blink, Off. The operator confirms **which physical lamp** lit. A lamp that
      lights the wrong component is a channel-map finding. Record the section, the channel shown on
      the page, and what actually lit.
- [ ] **Known suspect:** `payment` and semaphore green share channel 1 in the shipped map. The page
      flags it. Confirm what really lights for each.
- [ ] Bag tag left/right, semaphore green/red/yellow (yellow = red + green), and every strip colour
      including the mixes (cyan, magenta, yellow, white).
- [ ] Doors: the operator opens and closes the upper and lower service doors. Activity reports each
      move. **Known gap:** the page shows both doors "closed" until one moves, because their state is
      not read at connect. Note whether this misled you.
- [ ] All Off darkens everything (operator confirms). Disconnect leaves the board dark.
- [ ] Unplug/replug test (only if the operator agrees): with the board connected, ask the operator
      to unplug it. Activity should report it stopped. Reconnect after replugging.

**Card reader (Omron V4K)**

- [ ] Connect gives "Reader opened". After a power cycle, the driver resets the reader by itself.
- [ ] Read once, then the operator dips a **test** card: the read succeeds, the PAN is masked, and
      the track statuses look right. Try both read directions ("On withdrawal", "On insertion").
- [ ] A quick dip versus a slow dip: note whether quick dips are missed.
- [ ] Tracks: 1+2 (default), 1 only, 2 only, all three. A card without track 3 may fail the read
      when track 3 is requested. Record what happens.
- [ ] "Hold the card" on insertion / on withdrawal: the operator reports whether the card is held,
      and that it is released afterwards. If a card gets stuck, Initial reset and Disconnect, then
      tell the operator. Do not leave a card captured.
- [ ] Timeout: Read once with no card gives "No card arrived" after the wait. Cancel mid-wait ends it.
- [ ] Listen: several dips in a row, each reported once. Stop listening returns promptly.
- [ ] LED: every colour, Off, Blink (1 Hz). The operator confirms the bezel. Automatic mode: the
      operator describes what the reader does with its own LED.
- [ ] Identity reads the real version, serial and status.
- [ ] Clear read data and Initial reset are accepted.

**Together**

- [ ] With the light board and the card reader both connected, drive lamps while a read or Listen is
      in progress. Neither blocks or breaks the other.

## 4. Troubleshooting

- **`deno task check` fails with TS2307 and then a cascade of implicit-any errors.** The `links`
  path does not resolve. Fix the folder layout. Read the first error, not the loudest.
- **"Failed to load libusb-1.0"** means `libusb-1.0.dll` is not in the working directory. Run from the
  repo folder, or set `LIBUSB_PATH`.
- **"Failed to load hidapi"** means `hidapi.dll` is missing. Put it in the repo folder or set
  `HIDAPI_PATH`.
- **The light board opens but the handshake fails, or it is not found** means the device is still
  bound to `ierVBus` instead of WinUSB, or another process holds it.
- **The card reader is busy or does not answer** means the kiosk's application still holds it.
- **The page shows old behaviour** means `dist/` is stale. Run `npm run build` again.

## 5. Report back

Write `KIOSK-TEST-REPORT.md` in the repo root:

- Kiosk identity (asset tag if the operator gives one), Windows version, Deno/Node versions, the
  hardware-libs commit, how the DLLs and the WinUSB binding were provided, and the binding state you
  left the light board in.
- One table per section: check, result (pass / fail / blocked / not run), and evidence (the
  operator's words, the Activity line, masked screenshots).
- Findings, worst first. Separate **tester bugs** (this repo, with file:line if you found the cause)
  from **driver or channel-map findings** (hardware-libs; do not fix them, describe them).

Commit the report on `hardware-libs-master` and push it, after asking the operator. If you fixed a
tester bug, commit the fix separately with a message saying what was broken on hardware. Then tell
the operator the report is pushed.

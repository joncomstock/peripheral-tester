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

## What it is for

The driver is a port of a 214-line Python driver and **nothing in it has ever touched real
hardware**. This tool exists for the run that fixes that. Three things to establish, in order:

1. **The board's real reply token.** The expected `SY@` / `AI@` / `AL@` were read out of the Python
   driver's source, which stopped comparing them against the wire in the same commit that carried its
   hardware fixes — so they are plausible and were never recorded as confirmed. The driver accepts
   either `AI@` or `AI;5=O@` and warns, naming the token it actually saw. That warning goes to the
   driver's logger, which means this process's stdout — where nobody standing at a kiosk is looking —
   so the backend attaches a log handler and puts it on the page instead. Distinct unexpected replies
   are counted under **Inbound → Replies the driver did not expect**, and the full warning is in the
   stream, verbatim. **Read it.** If the board answers in a third
   shape the symptom is a resynchronisation per command: correct, slow, and loud. The fix is to teach
   the ack constants in the driver's `protocol.ts` the real token — deliberately not a config knob,
   because a per-install ack format would be a protocol difference rather than a wiring one.
2. **`payment` = channel 1 and `cardReader` = channel 2.** Both were `TODO ensure this works when
   hooked up` in the Python and never exercised. `payment` = 1 is the _same channel_ as the
   semaphore's green lamp, so pressing `payment` may light the semaphore instead. Both are labelled
   UNVERIFIED, and the collision is computed from the live channel map rather than hard-coded, so a
   collision a custom `config` introduces shows up the same way.
3. **Everything else the Python did exercise** — semaphore 6/1, bag-tag 8/9, strip 4/3/2, doors 1/3.
   Confirm, don't assume. The Python's own `scratch.py` carried a note that the right bag-tag channel
   lit the boarding-pass printer on the unit in front of its author, so treat the whole indicator map
   as per-install until a wired board says otherwise.

Corrections are configuration, not code: pass a `config` to `IERS33380.open()`. The channel map is a
property of how a kiosk is wired.

**Watch the board, not the screen.** A command that reports _sent_ only means the board answered —
not that the lamp you expected lit. That is the one thing this page cannot tell you, and it is why
each row has a place to record what actually happened. The record renders as markdown to paste into
the PR, and rows left as _not tested_ stay in it: what was not confirmed is the part that stops a
partial run reading as a complete one.

## Quick start

Prereqs: **Deno ≥ 2** and **Node ≥ 18**.

```bash
npm install            # frontend deps (one time)
npm run build          # bundle the UI into dist/ (one time / after UI edits)

deno task dev          # real board on COM14 — serves the API and the built UI
deno task dev COM3     # another port
deno task dev:mock     # no hardware
# → open http://localhost:8777/   (PORT overrides)
```

One process, because the one holding the COM handle has to be the one serving the page.

For frontend work, `npm run dev` runs Vite on `:5175` and proxies `/api` to the backend, so hot
reload works while the board stays on the Deno side (`TESTER_PORT` overrides the target).

Ctrl-C darkens the board and releases the port, so the next run can open it.

### Before `@eai/ier` is published

`@eai/ier` is not on the registry yet — publish order is `@eai/serial`, then `@eai/ier`. Until then
nothing runs from a clean clone. To work against unlanded driver work, swap the one line in
`deno.jsonc` for a relative path into a sibling checkout:

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
it records the local paths.

**Do not commit any of it.** A clone without `hardware-libs` beside it fails the same way, on a
config nobody thinks to suspect — this is a mistake `facepod-tester` had committed and had to fix.

## Mock mode

`deno task dev:mock` runs a fake `Transport` through the **real driver**, so the command
construction, framing and ack matching being exercised are the shipped ones. It answers every
command and reports a door every four seconds.

There is deliberately no mock in the browser. A second mock would be a copy that goes stale, and a
page that can fake a board is a page that can produce a screenshot nobody should trust. Mock runs are
stamped `MOCK — NO BOARD` on screen and `MOCK RUN — NOT EVIDENCE` in the exported record.

## Layout

| Path                   | What                                                              |
| ---------------------- | ----------------------------------------------------------------- |
| `server/main.ts`       | Owns the COM port. JSON + SSE API, and serves `dist/` on a kiosk. |
| `server/collisions.ts` | Which indicator channels two sections share, from the live map.   |
| `src/api.ts`           | Typed client for that API. No vocabulary of its own.              |
| `src/rows.ts`          | Payload → wiring bay, and observations → the markdown record.     |
| `src/styles.css`       | The design, and the rules behind it, in the header comment.       |
| `src/App.tsx`          | The page.                                                         |

The button grid is generated from `/api/vocabulary`, which the backend builds from the driver's own
exported vocabularies (`ACTIONS`, `INDICATOR_SECTIONS`, `STRIP_COLORS`, `SEMAPHORE_COLORS`, `SIDES`)
and the live channel map. Nothing here keeps its own list of sections, actions or channel numbers, so
this repo cannot disagree with the driver about what the board has.

## The design, and why it is like that

**The interface never depicts a lit lamp.** This page sits next to a physical board and must not look
more authoritative than it. Each row is a wire that reads left to right — section, what you send, the
pin it reaches, what your eyes saw — and the signal path stops at the pin, which is exactly where the
software's knowledge stops. The one animation, a pulse along the wire when you fire a command, stops
there too.

**Saturated colour means a person confirmed something.** Green, amber and red appear only on a
verdict an operator set. Everything the machine merely claims is grey. The single exception is a
service door standing open, which is amber for attention, because a door is not a lamp.

**A shared pin is stated at the pin.** Two sections on one channel is the defect this tool exists to
settle, so it is named on both rows beside the terminal rather than in a banner elsewhere, and the
marker jumps to the other claimant. There is no separate collisions panel.

**The top-level division is the protocol's.** Outbound is what you send; inbound is what the board
sends back. Doors are on the inbound side because the information flows the other way.

**Dark, deliberately, with no light theme.** Judging whether a dim amber LED is lit is much harder
next to a bright screen.

Type is paired on the width axis rather than the usual serif/sans one: Saira Condensed as an engraved
panel legend for labels and controls, IBM Plex Mono for anything the board said or the wire
addresses, IBM Plex Sans for prose, because the warnings are the safety-critical text and mono reads
slower at paragraph length. The fonts are bundled rather than linked — a kiosk may have no route to a
CDN, and a webfont that fails there fails silently into a fallback.

## Checks

```bash
deno task check && deno task test    # backend
npm test && npm run build            # frontend
```

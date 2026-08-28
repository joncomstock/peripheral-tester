import { assertEquals } from "@std/assert";
import { settings, state } from "./cardreader.ts";
import { ALL_TRACKS, TRACK_1, TRACK_2, TRACK_3 } from "@eai/omron/v4ku";

/**
 * The track bitmask and the digit the wire takes are not the same number.
 *
 * `@eai/omron`'s `protocol.ts` is explicit about it: the API side is a bitmask (1/2/4) and the wire
 * side enumerates the seven usable combinations 1..7 in order — the three singles, then the three
 * pairs, then all three. They coincide only for track 1 alone and for all three, "which is why
 * sending the bitmask straight through appeared to work, and diverge everywhere else".
 *
 * The driver translates correctly, so the device is always commanded properly. These are about the
 * literal the *page* shows: it exists so what goes on the wire is visible, and a chip that says
 * `C6a3` for a read the device receives as `C6a4` is worse than showing nothing.
 */
Deno.test("the read literal carries the wire digit, not the bitmask", () => {
  settings({ tracks: TRACK_1 | TRACK_2 });
  assertEquals(state().literals.read, "C6a4");
});

Deno.test("the two values that coincide still read correctly", () => {
  settings({ tracks: TRACK_1 });
  assertEquals(state().literals.read, "C6a1");
  settings({ tracks: ALL_TRACKS });
  assertEquals(state().literals.read, "C6a7");
});

Deno.test("every mask the page can produce has a wire digit", () => {
  const expected: Record<number, string> = {
    [TRACK_1]: "1",
    [TRACK_2]: "2",
    [TRACK_3]: "3",
    [TRACK_1 | TRACK_2]: "4",
    [TRACK_1 | TRACK_3]: "5",
    [TRACK_2 | TRACK_3]: "6",
    [ALL_TRACKS]: "7",
  };
  for (const [mask, digit] of Object.entries(expected)) {
    settings({ tracks: Number(mask) });
    assertEquals(state().literals.read, `C6a${digit}`, `mask ${mask}`);
  }
});

Deno.test("the prepare literal carries the same wire digit, between direction and the locks", () => {
  settings({ direction: "insertion", tracks: TRACK_1 | TRACK_2, insertionLock: true, pullOutLock: false });
  assertEquals(state().literals.prepare, "C:61410");
});

Deno.test("the shipped default asks for tracks 1 and 2, as the driver's own default does", () => {
  // Reaches the module's initial value rather than whatever an earlier test left behind.
  const fresh = new URL("./cardreader.ts", import.meta.url).href + "?fresh";
  return import(fresh).then((module: typeof import("./cardreader.ts")) => {
    assertEquals(module.state().transaction.tracks, TRACK_1 | TRACK_2);
  });
});

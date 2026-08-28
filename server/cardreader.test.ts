import { assertEquals } from "@std/assert";
import { describeTrackReply, settings, state } from "./cardreader.ts";
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

/**
 * The diagnostic's whole risk is here: the payload after a track read is the stripe, and the
 * activity log is guaranteed never to carry one. Only the fixed header — the echoed mask, a status
 * per track and a length per track — is safe to record.
 *
 * Deciding "is this a header" by looking for leading digits is not enough, and the reason is
 * specific: the wire digit for tracks 1 and 2 is `4`, and a Visa PAN starts with `4`. A reply that
 * carried track 2 straight up, with no header, would pass that test and put the first eleven
 * digits of a card number in the log. So the guard is the driver's own — the mask must echo what
 * was asked for — plus a consistency check the stripe cannot satisfy: the lengths the header
 * declares have to fit inside the payload that follows it.
 */
Deno.test("a header-shaped reply is described by its header", () => {
  // mask 4, statuses 00 and 00, lengths 005 and 005, then the ten bytes those lengths promise.
  assertEquals(
    describeTrackReply("P6a00", "40000005005" + "x".repeat(10), TRACK_1 | TRACK_2),
    "P6a00 — 21 bytes, mask 4, status 00/00, length 005/005",
  );
});

Deno.test("a bare track 2 is not mistaken for a header, though its first digits look like one", () => {
  // Every byte a digit, and the first is `4` — the wire digit for the mask that was requested.
  // Only the length check rejects this, and it is the one that matters.
  const stripe = "4111111111111111=29092010000259";
  const described = describeTrackReply("P6a00", stripe, TRACK_1 | TRACK_2);
  assertEquals(described, "P6a00 — 31 bytes, payload not in header shape");
  assertEquals(described.includes("4111"), false);
});

Deno.test("a reply carrying track 1 records no stripe", () => {
  const stripe = "B4111111111111111^SANDOVAL/MARIA^29092010000259";
  const described = describeTrackReply("P6a00", stripe, TRACK_1 | TRACK_2);
  assertEquals(described.includes("4111"), false);
  assertEquals(described.includes("SANDOVAL"), false);
});

Deno.test("a mask that is not the one asked for is not a header", () => {
  // Well-formed in every other way, but the device did not echo the requested mask.
  assertEquals(
    describeTrackReply("P6a00", "700000000000", TRACK_1 | TRACK_2),
    "P6a00 — 12 bytes, payload not in header shape",
  );
});

Deno.test("a reply too short to hold a header records only its length", () => {
  assertEquals(describeTrackReply("N6a49", "49", TRACK_1 | TRACK_2), "N6a49 — 2 bytes, payload not in header shape");
});

Deno.test("an empty payload is described without inventing a header", () => {
  assertEquals(describeTrackReply("N6a49", "", TRACK_1 | TRACK_2), "N6a49 — 0 bytes, no payload");
});

Deno.test("the failure this diagnostic exists for is described in full", () => {
  // `N6a49` with all three tracks answering 49 and no data — the shape `track.ts` records.
  assertEquals(
    describeTrackReply("N6a49", "7494949000000000", ALL_TRACKS),
    "N6a49 — 16 bytes, mask 7, status 49/49/49, length 000/000/000",
  );
});

Deno.test("the header width follows how many tracks were asked for", () => {
  assertEquals(describeTrackReply("P6a00", "100003" + "xxx", TRACK_1), "P6a00 — 9 bytes, mask 1, status 00, length 003");
});

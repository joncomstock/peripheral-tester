import { assertEquals } from "@std/assert";
import { configure, connect, describeTrackReply, diagnosticRead, disconnect, readDelays, reopen, settings, state } from "./cardreader.ts";
import { history } from "./activity.ts";
import { ALL_TRACKS, DEFAULT_CLEAR_READ_DELAY_MS, DEFAULT_TRACK_READ_DELAY_MS, TRACK_1, TRACK_2, TRACK_3 } from "@eai/omron/v4ku";

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
 * was asked for — plus the consistency checks a stripe cannot satisfy: the declared lengths have to
 * account for the payload **exactly**, a track that failed to read cannot carry bytes, and a
 * declared track 1 cannot contain track 2's separator.
 *
 * The exactness is the part that was wrong, and the tests below are why it is written down: real
 * card numbers, each of which cleared an at-most test and printed its own first eleven digits.
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

/**
 * Three real Visa numbers that an at-most length test reported as headers.
 *
 * Each is a bare track 2 — no header at all — whose own digits fall into header shape. Concatenate
 * the mask, statuses and lengths such a reply is described with and the card's first eleven digits
 * come back in order, five past the six a BIN may show. The first two leave bytes unaccounted for,
 * which only an exact test rejects; the third adds up exactly and is caught by the separator
 * sitting inside the track 1 it claims.
 */
Deno.test("a bare track 2 whose digits add up is still not a header", () => {
  for (const stripe of ["4000000000000002=29092010000259", "4147200001000000=29092010000259", "4000002000012345=29092010000259"]) {
    const described = describeTrackReply("P6a00", stripe, TRACK_1 | TRACK_2);
    assertEquals(described, `P6a00 — ${stripe.length} bytes, payload not in header shape`, stripe);
    assertEquals(described.includes(stripe.slice(0, 7)), false, `${stripe} leaked its own digits`);
  }
});

Deno.test("a track that failed to read cannot also have carried bytes", () => {
  // Status 14 and 72 on the two tracks, yet track 2 declares ten bytes. A device does not say both.
  assertEquals(
    describeTrackReply("P6a00", "41472000010" + "x".repeat(10), TRACK_1 | TRACK_2),
    "P6a00 — 21 bytes, payload not in header shape",
  );
});

/**
 * A partial read is the diagnostic, not noise to be filtered out.
 *
 * An intermittently-failing reader answers with short declared lengths against a mixed status, and
 * that reading is what says the head got some of the stripe rather than none of it. An earlier
 * version of this guard mirrored the driver's ISO length floors — the driver applies those to
 * decide whether to *slice*, a different question from whether to report — and suppressed all three
 * of these behind `payload not in header shape`, at exactly the bench session they exist for.
 * Dropping the floors costs nothing: 400,000 synthetic track-2 stripes were checked without them
 * and none was believed.
 */
Deno.test("a partial read reports its short lengths rather than being suppressed", () => {
  const partial: [string, string][] = [
    ["4" + "0049" + "008" + "000" + "x".repeat(8), "mask 4, status 00/49, length 008/000"],
    ["4" + "4900" + "000" + "009" + "x".repeat(9), "mask 4, status 49/00, length 000/009"],
    ["4" + "0000" + "006" + "004" + "x".repeat(10), "mask 4, status 00/00, length 006/004"],
  ];
  for (const [reply, expected] of partial) {
    assertEquals(describeTrackReply("P6a00", reply, TRACK_1 | TRACK_2), `P6a00 — ${reply.length} bytes, ${expected}`, reply);
  }
});

/**
 * The mock and the guard, checked against each other rather than each against its own idea.
 *
 * These are two halves of one wire format and nothing else lines them up. When the mock answered
 * with no header at all, every mock diagnostic read printed the guard's reject path and the path a
 * real device takes was never exercised outside the unit tests above. Both halves looked right on
 * their own, which is the failure a lockstep test catches and a fixture assertion does not.
 */
Deno.test("a mock read is described by its header, not rejected as shapeless", async () => {
  configure({ mock: true });
  settings({ tracks: TRACK_1 | TRACK_2 });
  await connect();
  try {
    const before = history().length;
    await diagnosticRead();
    const replies = history().slice(before).map((entry) => entry.text).filter((text) => text.includes("bytes"));

    const track = replies.find((text) => text.startsWith("P6a00"));
    assertEquals(track !== undefined, true, `no track-read reply in ${JSON.stringify(replies)}`);
    assertEquals(track!.includes("mask 4, status 00/00, length 067/031"), true, track);
    // The whole point of the header: the stripe it describes is not in what got recorded.
    assertEquals(replies.some((text) => text.includes("4111")), false, JSON.stringify(replies));
    assertEquals(replies.some((text) => text.includes("SANDOVAL")), false, JSON.stringify(replies));
  }
  finally {
    await disconnect();
  }
});

/**
 * The two read delays the bench exists to test away.
 *
 * They are constructor options on `OmronV4KU` and `readonly` on the instance, so unlike the
 * transaction settings they cannot be changed on a live reader — the reader has to be reopened. That
 * is the whole shape of what follows.
 */
Deno.test("the shipped read delays are the driver's own, not numbers restated here", () => {
  const fresh = new URL("./cardreader.ts", import.meta.url).href + "?delays";
  return import(fresh).then((module: typeof import("./cardreader.ts")) => {
    assertEquals(module.state().delays.trackReadDelayMs, DEFAULT_TRACK_READ_DELAY_MS);
    assertEquals(module.state().delays.clearReadDelayMs, DEFAULT_CLEAR_READ_DELAY_MS);
    // Served so the page can offer "back to shipped" without writing the numbers down itself.
    assertEquals(module.state().delays.shipped.trackReadDelayMs, DEFAULT_TRACK_READ_DELAY_MS);
    assertEquals(module.state().delays.shipped.clearReadDelayMs, DEFAULT_CLEAR_READ_DELAY_MS);
  });
});

Deno.test("a read delay is whole milliseconds and never negative", () => {
  // The driver validates its own options, but it does so by throwing in the constructor — which
  // here would mean a reopen that fails and leaves the bench with no reader at all.
  readDelays({ trackReadDelayMs: -5, clearReadDelayMs: 12.7 });
  assertEquals(state().delays.trackReadDelayMs, 0);
  assertEquals(state().delays.clearReadDelayMs, 13);
});

/**
 * `pending` is answered by the reader, not by a copy of what we asked for.
 *
 * The value it compares against is read back off the live `OmronV4KU`, so `pending === false`
 * straight after a connect is the assertion that the driver actually received them.
 */
Deno.test("connecting hands the delays to the driver, and pending says when the live reader differs", async () => {
  configure({ mock: true });
  readDelays({ trackReadDelayMs: 0, clearReadDelayMs: 0 });
  await connect();
  try {
    assertEquals(state().delays.pending, false);
    readDelays({ trackReadDelayMs: 500 });
    assertEquals(state().delays.pending, true);
  }
  finally {
    await disconnect();
  }
});

Deno.test("reopening rebuilds the reader on the new delays", async () => {
  configure({ mock: true });
  readDelays({ trackReadDelayMs: 500, clearReadDelayMs: 200 });
  await connect();
  try {
    readDelays({ trackReadDelayMs: 0, clearReadDelayMs: 0 });
    assertEquals(state().delays.pending, true);
    await reopen();
    assertEquals(state().delays.pending, false);
    assertEquals(state().status, "open");
  }
  finally {
    await disconnect();
  }
});

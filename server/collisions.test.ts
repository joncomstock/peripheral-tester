import { assertEquals } from "@std/assert";
import { aiCollisions } from "./collisions.ts";

/** The shipped `IER_S33380_DEFAULTS`, structurally. */
const defaults = {
  indicators: { payment: 1, cardReader: 2, passportReader: 3, boardingPassPrinter: 4, gppDispenser: 5 },
  bagTag: { left: 8, right: 9 },
  semaphore: { yellow: [6, 1], green: [1], red: [6] },
};

Deno.test("finds payment against semaphore green in the shipped defaults", () => {
  assertEquals(aiCollisions(defaults), [{ channel: 1, labels: ["payment", "semaphore green"] }]);
});

Deno.test("the strip's own channels never collide with indicators", () => {
  // strip green = 4 shares a number with boardingPassPrinter = 4, but AL and AI are separate
  // address spaces. The strip is not an input to aiCollisions at all — this asserts it stays out.
  assertEquals(aiCollisions({ ...defaults, indicators: { boardingPassPrinter: 4 } }), []);
});

Deno.test("semaphore yellow reusing red and green is not reported", () => {
  // yellow = [6, 1] is red = [6] and green = [1] lit together by design.
  assertEquals(aiCollisions({ indicators: {}, bagTag: {}, semaphore: { yellow: [6, 1], green: [1], red: [6] } }), []);
});

Deno.test("a corrected payment channel clears the collision", () => {
  // What the on-device run is for: confirm the channel, pass a config, and the warning goes away
  // on its own rather than needing a comment edited.
  const corrected = { ...defaults, indicators: { ...defaults.indicators, payment: 7 } };
  assertEquals(aiCollisions(corrected), []);
});

Deno.test("a collision a custom config introduces is found too", () => {
  const custom = { ...defaults, bagTag: { left: 3, right: 9 } };
  assertEquals(aiCollisions(custom), [
    { channel: 1, labels: ["payment", "semaphore green"] },
    { channel: 3, labels: ["passportReader", "bag-tag left"] },
  ]);
});

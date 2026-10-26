import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { delay } from "@std/async";
import { MSG_SET_JACK_LED, MSG_SET_KEYPRESS_BEEP, MSG_SET_LED } from "@eai/storm";
import * as storm from "./storm.ts";

Deno.test("the mock Nav-Pad reports keys and the jack, and answers its controls", async () => {
  storm.configure({ mock: true });
  await storm.connect();
  try {
    let state = storm.state();
    assertEquals(state.status, "open");
    assertEquals([state.firmware, state.serial, state.keypadType, state.led], ["V4.0", "MOCK00000001", "8 key", 9]);
    assertEquals(state.keys.length, 8);
    assertThrows(() => storm.configure({ mock: false }), Error, "Disconnect before changing mode");

    // A press shows held, lands in the history, and releases on its own.
    storm.actions.simulate({ event: "press", key: "up" });
    await delay(50);
    assertEquals(storm.state().held, ["up"]);
    assertEquals(storm.state().presses[0].key, "up");
    await delay(300);
    assertEquals(storm.state().held, []);
    // Every key in the driver's vocabulary, one at a time (a boot report holds only six at once).
    for (const key of storm.state().keys) {
      storm.actions.simulate({ event: "press", key });
      await delay(270);
    }
    assertEquals(storm.state().presses.map((p) => p.key).slice(0, 8), [...storm.state().keys].reverse());
    assertThrows(() => storm.actions.simulate({ event: "press", key: "jack-inserted" }), Error, "not a Nav-Pad key");

    // The jack settles past the driver's debounce.
    storm.actions.simulate({ event: "jack", inserted: true });
    await delay(700);
    assertEquals(storm.state().jack, true);
    storm.actions.simulate({ event: "jack", inserted: false });
    await delay(700);
    assertEquals(storm.state().jack, false);

    // Controls round-trip through the status the keypad reports back.
    await storm.actions.led({ level: 3 });
    await storm.actions["jack-led"]({ level: 5 });
    await storm.actions["keypress-beep"]({ on: false });
    await storm.actions.buzz({ quarters: 2 });
    await storm.actions.status({});
    state = storm.state();
    assertEquals([state.led, state.jackLed, state.keypressBeep], [3, 5, false]);
    await assertRejects(async () => await storm.actions.led({ level: 10 }), Error, "0..9");
    await assertRejects(async () => await storm.actions.buzz({ quarters: 200 }), Error, "1..8");
    await assertRejects(async () => await storm.actions["keypress-beep"]({ on: "yes" }), Error, "true or false");
  }
  finally {
    storm.mockTrace.length = 0;
    await storm.disconnect();
  }
  // The keys go back to the OS before any command, then the settings found at connect are restored.
  assertEquals(storm.mockTrace, [
    "capture closed",
    `${MSG_SET_LED}:9`,
    `${MSG_SET_JACK_LED}:0`,
    `${MSG_SET_KEYPRESS_BEEP}:1`,
  ]);
  assertEquals(storm.state().status, "closed");
  assertThrows(() => storm.actions.simulate({ event: "press", key: "up" }), Error, "Only a mock");
  await storm.disconnect(); // idempotent
});

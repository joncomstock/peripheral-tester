import { assertEquals, assertThrows } from "@std/assert";
import * as embross from "./embross.ts";

/** Wait for the driver's next sample or two to see what the page simulated. */
async function until(check: () => boolean) {
  for (let i = 0; i < 40 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
}

Deno.test("mock Embross switches: door and button transitions, port choice", async () => {
  embross.configure({ mock: true });

  // The port is validated and only changes while closed.
  assertThrows(() => embross.actions.port({ port: "COM1; rm -rf" }), Error, "not a serial port");
  assertThrows(() => embross.actions.port({ port: 3 }), Error, "must be a string");
  embross.actions.port({ port: "COM2" });
  assertEquals(embross.state().port, "COM2");
  assertThrows(() => embross.actions.simulate({ switch: "door", on: true }), Error, "Only mock");

  await embross.connect();
  try {
    assertEquals(embross.state().status, "open");
    assertEquals([embross.state().doorOpen, embross.state().buttonPressed], [false, false]);
    assertThrows(() => embross.configure({ mock: false }), Error, "Disconnect before changing mode");
    assertThrows(() => embross.actions.port({ port: "COM1" }), Error, "Disconnect before changing port");
    assertThrows(() => embross.actions.simulate({ switch: "lid", on: true }), Error, "unknown switch");
    assertThrows(() => embross.actions.simulate({ switch: "door", on: "yes" }), Error, "true or false");

    embross.actions.simulate({ switch: "door", on: true });
    await until(() => embross.state().doorOpen === true);
    embross.actions.simulate({ switch: "button", on: true });
    await until(() => embross.state().buttonPressed === true);
    embross.actions.simulate({ switch: "button", on: false });
    embross.actions.simulate({ switch: "door", on: false });
    await until(() => embross.state().doorOpen === false && embross.state().buttonPressed === false);

    assertEquals(embross.state().transitions.map((t) => t.text).reverse(), [
      "Door opened",
      "Service button pressed",
      "Door shut",
      "Service button released",
    ]);
  }
  finally {
    await embross.disconnect();
  }
  assertEquals(embross.state().status, "closed");
  assertEquals(embross.state().doorOpen, null);
  await embross.disconnect();
});

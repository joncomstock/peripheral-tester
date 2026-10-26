import { assertEquals, assertRejects } from "@std/assert";
import * as allpixel from "./allpixel.ts";

Deno.test("the mock AllPixel lights zones, reports what was commanded, and goes dark on disconnect", async () => {
  allpixel.configure({ mock: true });
  await allpixel.connect();
  try {
    assertEquals(allpixel.state().status, "open");
    assertEquals(allpixel.state().usbId, "1d50:60ab");
    assertEquals(allpixel.state().boardId, 7);
    assertEquals(allpixel.state().lit.all, "off");

    await allpixel.actions.fill({ zone: "top", color: "white" });
    await allpixel.actions.fill({ zone: "base", color: "blue" });
    assertEquals(allpixel.state().lit.top, "white");
    assertEquals(allpixel.state().lit.base, "blue");
    assertEquals(allpixel.state().lit.all, "mixed");

    await allpixel.actions.fill({ zone: "cardReader", color: "green" });
    await allpixel.actions.fill({ zone: "corners", color: "red" });
    assertEquals(allpixel.state().lit.cardReader, "mixed"); // its last LED is the front-right corner
    assertEquals(allpixel.state().lit.corners, "red");
    await allpixel.actions.fill({ zone: "top", color: "off" });
    assertEquals(allpixel.state().lit.top, "off");

    await assertRejects(async () => await allpixel.actions.fill({ zone: "roof", color: "red" }), Error, "not a zone");
    await assertRejects(async () => await allpixel.actions.fill({ zone: "top", color: "#fff" }), Error, "not a colour");

    await allpixel.actions["all-off"]({});
    assertEquals(allpixel.state().lit.base, "off");
  }
  finally {
    await allpixel.disconnect();
  }
  assertEquals(allpixel.state().status, "closed");
});

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import * as adr300 from "./adr300.ts";

Deno.test("adr300: the mock reader is driven through the real driver", async () => {
  adr300.configure({ mock: true });
  await adr300.connect();
  try {
    assertEquals(adr300.state().status, "open");
    assertEquals(adr300.state().illumination, { profile: 0, mode: "Off" });
    assertThrows(() => adr300.configure({ mock: false }), Error, "Disconnect before changing mode");

    // The written mode comes back as the reader's LED profile code, mapped to its name.
    await adr300.actions.illumination({ mode: "Visible" });
    assertEquals(adr300.state().illumination, { profile: 0x0001, mode: "Visible" });
    assertThrows(() => adr300.actions.illumination({ mode: "Laser" }), Error, "not an illumination mode");

    await adr300.actions.led({ color: "green", side: "left" });
    assertEquals(adr300.state().led, { color: "green", side: "left" });
    await adr300.actions.led({ color: "off" });
    assertEquals(adr300.state().led, null);
    assertThrows(() => adr300.actions.led({ color: "purple" }), Error, "not an LED colour");

    await adr300.actions.sound({ pattern: "Ascending" });
    assertEquals(await adr300.actions.identity({}), { firmware: 0x25, fpga: 0x0102, psoc: 5 });

    // A pulled cable surfaces at the next command, and the session lets go.
    adr300.actions.simulate({ event: "unplug" });
    await assertRejects(() => adr300.actions.sound({ pattern: "Silence" }) as Promise<unknown>);
    assertEquals(adr300.state().status, "closed");

    await adr300.connect();
    assertEquals(adr300.state().status, "open");
  }
  finally {
    await adr300.disconnect();
  }
  assertEquals(adr300.state().status, "closed");
  assertThrows(() => adr300.actions.simulate({ event: "unplug" }), Error, "Only a mock reader");
});

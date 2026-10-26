import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import * as custom from "./custom.ts";

Deno.test("the mock KPM180-H reports status, identifies, prints and faults through the real driver", async () => {
  custom.configure({ mock: true });
  await custom.connect();
  const { actions } = custom;
  try {
    assertEquals(custom.state().status, "open");
    assertEquals(custom.state().usbId, "0dd4:0208");
    assertEquals(custom.state().paper?.faults, []);
    assertThrows(() => custom.configure({ mock: false }), Error, "Disconnect before changing mode");

    const id = await actions.identity({}) as { model: string; firmware: string; serialNumber: string; firmwareLines: string[] };
    assertEquals([id.model, id.firmware, id.serialNumber], ["0x0208 (KPM180H)", "1.81", "MOCK000000000001"]);
    assertEquals(id.firmwareLines[0], "KPM180-H ETH IBM printer");

    await actions.print({});
    assertEquals(custom.state().paper?.ticketAtExit, true);
    assertEquals(custom.state().busy, false);

    await actions.simulate({ condition: "paper-low" });
    assertEquals(custom.state().paper?.paperLow, true);
    await actions.simulate({ condition: "jam" });
    assertEquals(custom.state().paper?.paperJam, true);
    await actions.simulate({ condition: "paper-out" });
    assertEquals(custom.state().paper?.faults, ["paper jam", "paper out"]);
    await assertRejects(async () => await actions.print({}), Error, "Printer fault: paper jam, paper out");
    assertEquals(custom.state().busy, false);

    await actions.simulate({ condition: "clear" });
    await actions.status({});
    assertEquals(custom.state().paper, {
      paperOut: false,
      paperLow: false,
      paperJam: false,
      coverOpen: false,
      ticketAtExit: false,
      faults: [],
    });
    await assertRejects(async () => await actions.simulate({ condition: "fire" }), Error, "condition must be");
  }
  finally {
    await custom.disconnect();
  }
  assertEquals(custom.state().status, "closed");
  await custom.disconnect(); // idempotent
});

Deno.test("the sample ticket fits 50 mm stock", () => {
  const ticket = custom.sampleTicket();
  assertEquals(ticket.width, 384);
  assertEquals(ticket.data.length, (384 / 8) * ticket.height);
  assertEquals(ticket.data[0], 0xff); // the frame's top-left corner
});

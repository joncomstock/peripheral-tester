import { assert, assertEquals, assertThrows } from "@std/assert";
import * as lightboard from "./lightboard.ts";
import * as cardreader from "./cardreader.ts";
import * as sankyo from "./sankyo.ts";
import * as penta from "./penta.ts";

// Every device of a kiosk open at once, each driven through its real driver over a mock transport.
Deno.test("all four mock devices run side by side", async () => {
  lightboard.configure({ mock: true });
  cardreader.configure({ mock: true });
  sankyo.configure({ mock: true });
  penta.configure({ mock: true });
  await Promise.all([lightboard.connect(), cardreader.connect(), sankyo.connect(), penta.connect()]);
  try {
    assertEquals(
      [lightboard.state().status, cardreader.state().status, sankyo.state().status, penta.state().status],
      ["open", "open", "open", "open"],
    );
    // The mode never changes under an open device.
    assertThrows(() => cardreader.configure({ mock: false }), Error, "Disconnect before changing mode");

    // One read per reader and a lamp on the board, all in flight together.
    const sankyoRead = sankyo.read();
    setTimeout(() => sankyo.simulateCard(true), 50);
    const [v4k, icm] = await Promise.all([
      cardreader.read(),
      sankyoRead,
      lightboard.led({ section: "semaphore", action: "on", color: "green" }),
    ]);
    assertEquals(v4k.kind, "card");
    assertEquals(v4k.card?.track2?.fields?.pan, "4111111111111111");
    assertEquals(icm.kind, "card");
    assertEquals(icm.card?.track1?.fields?.name.trim(), "SANDOVAL/MARIA");

    // The Penta: a boarding pass on the glass is announced and decoded; its controls are answered.
    penta.simulate("boarding-pass");
    for (let i = 0; i < 50 && !penta.state().barcode; i++) await new Promise((r) => setTimeout(r, 50));
    assertEquals(penta.state().document, "present");
    assertEquals(penta.state().barcode?.symbology, "]L2");
    await penta.setStatusLed("flash", "green");
    await penta.setExternalLed("yellow");
    await penta.beep();
    await penta.setFloodLevel(18);
    assertEquals(penta.state().floodLevel, 18);
    penta.simulate("remove");
    // The mock passport's MRZ is well formed: 2 lines of 44, and cleared when the document leaves.
    // Straight after the remove, with its "removed" still queued: the passport must survive it.
    penta.simulate("passport");
    for (let i = 0; i < 50 && !penta.state().passport; i++) await new Promise((r) => setTimeout(r, 50));
    assertEquals(penta.state().passport?.mrz.map((line) => line.length), [44, 44]);
    penta.simulate("remove");
    for (let i = 0; i < 50 && penta.state().passport; i++) await new Promise((r) => setTimeout(r, 50));
    assertEquals(penta.state().passport, null);

    // A refused track read surfaces as unreadable, not as a thrown error.
    cardreader.arm("unreadable");
    assertEquals((await cardreader.read()).kind, "readFailed");

    // The Sankyo monitor delivers a card that arrives while listening, and the V4K listen loop stops.
    sankyo.simulateCard(false);
    await sankyo.startListening();
    cardreader.startListening();
    sankyo.simulateCard(true);
    for (let i = 0; i < 50 && !sankyo.state().cardWaiting; i++) await new Promise((r) => setTimeout(r, 50));
    assert(sankyo.takeCard()?.track2?.fields, "the monitor should have read the inserted card");
    await sankyo.stopListening();

    // The V4K's loop reads a card when presence reports one, once.
    cardreader.arm("card");
    for (let i = 0; i < 50 && !cardreader.state().cardWaiting; i++) await new Promise((r) => setTimeout(r, 50));
    assert(cardreader.takeCard()?.track2?.fields, "the listen loop should have read the arriving card");
    await cardreader.stopListening();
    assertEquals(cardreader.state().listening, false);
    // Nothing the stop sent may cancel the next command.
    cardreader.arm("card");
    assertEquals((await cardreader.read()).kind, "card");
  }
  finally {
    await Promise.all([lightboard.disconnect(), cardreader.disconnect(), sankyo.disconnect(), penta.disconnect()]);
  }
});

import { assert, assertEquals } from "@std/assert";
import * as lightboard from "./lightboard.ts";
import * as cardreader from "./cardreader.ts";
import * as sankyo from "./sankyo.ts";

// Every device of a kiosk open at once, each driven through its real driver over a mock transport.
Deno.test("all three mock devices run side by side", async () => {
  lightboard.configure({ mock: true });
  cardreader.configure({ mock: true });
  sankyo.configure({ mock: true });
  await Promise.all([lightboard.connect(), cardreader.connect(), sankyo.connect()]);
  try {
    assertEquals([lightboard.state().status, cardreader.state().status, sankyo.state().status], ["open", "open", "open"]);

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
    await cardreader.stopListening();
  }
  finally {
    await Promise.all([lightboard.disconnect(), cardreader.disconnect(), sankyo.disconnect()]);
  }
});

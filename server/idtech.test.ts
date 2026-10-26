import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { history } from "./activity.ts";
import * as idtech from "./idtech.ts";

const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 50 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(predicate(), "condition not met in time");
};

Deno.test("idtech: the mock reader is driven through the real driver", async () => {
  idtech.configure({ mock: true });
  await idtech.connect();
  try {
    assertEquals(idtech.state().status, "open");
    assertEquals(idtech.state().slot, { present: false, seated: false });
    assertThrows(() => idtech.configure({ mock: false }), Error, "Disconnect before changing mode");

    const about = await idtech.actions.identity({}) as { version: string; serialNumber: string; status: string };
    assertEquals([about.serialNumber, about.status], ["MOCK0001", "slot empty"]);

    // A read takes the next card the reader reports; the card is in the reply and nowhere else.
    const reading = idtech.actions.read({}) as Promise<idtech.ReadResult>;
    assertEquals(idtech.state().reading, true);
    idtech.actions.simulate({ card: "card" });
    const read = await reading;
    assertEquals(read.kind, "card");
    assertEquals(read.card?.track2?.fields?.pan, "4111111111111111");
    assertEquals(read.card?.track1?.fields?.name, "SANDOVAL/MARIA");
    assertEquals(idtech.state().reading, false);
    assert(!JSON.stringify(idtech.state()).includes("4111"), "state must carry no card data");

    const unreadable = idtech.actions.read({}) as Promise<idtech.ReadResult>;
    idtech.actions.simulate({ card: "unreadable" });
    assertEquals((await unreadable).kind, "readFailed");

    const cancelled = idtech.actions.read({}) as Promise<idtech.ReadResult>;
    idtech.actions.cancel({});
    assertEquals((await cancelled).kind, "cancelled");

    // Listening keeps the card for one collection.
    idtech.actions.listen({});
    assertThrows(() => idtech.actions.read({}), Error, "Stop listening first");
    idtech.actions.simulate({ card: "card" });
    await until(() => idtech.state().cardWaiting);
    assert(!JSON.stringify(idtech.state()).includes("4111"), "state must carry no card data");
    const taken = idtech.actions["take-card"]({}) as { card: idtech.Card | null };
    assertEquals(taken.card?.track2?.fields?.pan, "4111111111111111");
    assertEquals((idtech.actions["take-card"]({}) as { card: idtech.Card | null }).card, null);
    idtech.actions.stop({});
    assertEquals(idtech.state().listening, false);

    assertThrows(() => idtech.actions.simulate({ card: "gift" }), Error, "not a mock card");
  }
  finally {
    await idtech.disconnect();
  }
  assertEquals(idtech.state().status, "closed");
  assert(!JSON.stringify(history()).match(/4111|SANDOVAL/), "the log must carry no card data");
  await assertRejects(async () => await idtech.actions.identity({}), Error, "Not connected");
});

Deno.test("idtech: a reader lost underneath is released, so it can be opened again", async () => {
  idtech.configure({ mock: true });
  await idtech.connect();
  idtech.actions.simulate({ event: "unplug" });
  await until(() => idtech.state().status === "closed");
  // The mock refuses a second open while the first handle is still held.
  await idtech.connect();
  assertEquals(idtech.state().status, "open");
  await idtech.disconnect();
});

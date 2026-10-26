import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { history } from "./activity.ts";
import * as xpm from "./xpm.ts";

Deno.test("the sample pass fills the page width and is long enough to cut", () => {
  const rows = xpm.samplePass(new Date("2026-10-26T12:00:00Z"));
  assertEquals(rows.length, 900);
  assert(rows.every((row) => row.length === 72));
  // The frame is solid along the top.
  assert(rows[0].every((byte) => byte === 0xff));
});

// The real driver over the fake printer: status, identity, a test print, and every simulated fault.
Deno.test("mock XPM: status, identity, test print and paper faults", async () => {
  xpm.configure({ mock: true });
  await xpm.connect();
  try {
    assertEquals(xpm.state().status, "open");
    assertEquals(xpm.state().usbId, "1bf1:0016");
    assertEquals(xpm.state().printer?.paper, "ok");
    assertEquals(xpm.state().printer?.temperature, 31);
    assertThrows(() => xpm.configure({ mock: false }), Error, "Disconnect before changing mode");

    const info = await xpm.actions.identity({}) as { model: string; serialNumber: string };
    assertEquals(info.model, "XPM-200HR");
    assertEquals(info.serialNumber, "MOCK0001");

    await xpm.actions["print-test"]({});
    assertEquals(xpm.state().printing, false);
    assert(xpm.state().printer?.flags.includes("paperInChute"));
    await xpm.actions.simulate({ action: "take" });
    assert(!xpm.state().printer?.flags.includes("paperInChute"));

    await xpm.actions.simulate({ action: "paper-low" });
    assertEquals(xpm.state().printer?.paper, "low");
    await xpm.actions["print-test"]({}); // low paper still prints

    await xpm.actions.simulate({ action: "paper-out" });
    assertEquals(xpm.state().printer?.paper, "out");
    assertEquals(xpm.state().trouble, "Paper out");
    const sent = history().filter((e) => e.text === "Test pass sent").length;
    await assertRejects(() => xpm.actions["print-test"]({}) as Promise<unknown>, Error, "Paper out");
    // Refused before anything reached the printer, so no job sits queued waiting for paper.
    assertEquals(history().filter((e) => e.text === "Test pass sent").length, sent);
    assertEquals(xpm.state().printing, false);
    await xpm.actions.simulate({ action: "paper-ok" });

    await xpm.actions.simulate({ action: "jam" });
    assertEquals(xpm.state().printer?.error, { type: "Paper jammed", context: "While printing" });
    await assertRejects(() => xpm.actions["print-test"]({}) as Promise<unknown>, Error, "Paper jammed");
    await xpm.actions.simulate({ action: "clear-jam" });
    assertEquals(xpm.state().printer?.error, null);

    await assertRejects(() => xpm.actions.simulate({ action: "explode" }) as Promise<unknown>, Error, "unknown simulation");
  }
  finally {
    await xpm.disconnect();
  }
  assertEquals(xpm.state().status, "closed");
  await assertRejects(() => xpm.actions.identity({}) as Promise<unknown>, Error, "Not connected");
});

Deno.test("mock XPM: disconnect during a print waits for the print to finish", async () => {
  xpm.configure({ mock: true });
  await xpm.connect();
  const sends = () => history().filter((e) => e.device === "xpm" && e.text === "Test pass sent").length;
  const before = sends();
  const print = xpm.actions["print-test"]({}) as Promise<unknown>;
  // Let the pre-print status read land so the print itself is under way.
  while (sends() === before) await new Promise((r) => setTimeout(r, 5));
  let printed = false;
  const done = print.then(() => printed = true);
  await xpm.disconnect();
  assert(printed, "disconnect returned before the print it would cut off");
  await done;
  assertEquals(xpm.state().status, "closed");
});

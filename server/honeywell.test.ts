import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import * as honeywell from "./honeywell.ts";

const { actions } = honeywell;
const settle = async (done: () => boolean) => {
  for (let i = 0; i < 50 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
};

// The real driver over the mock scanner: framing, Code ID prefix, modes and settings.
Deno.test("the mock 5X80 reads, triggers, and takes its settings", async () => {
  honeywell.configure({ mock: true });
  await honeywell.connect();
  try {
    assertEquals(honeywell.state().status, "open");
    assertEquals(honeywell.state().usbId, "0536:030a");
    assertEquals(honeywell.state().beeper, { on: true, volume: 3 });
    assertThrows(() => honeywell.configure({ mock: false }), Error, "Disconnect before changing mode");

    // Not reading: the scanner ignores what is presented.
    assertThrows(() => actions.simulate({ code: "qr" }), Error, "not reading");

    // Presentation mode reads one code after another, symbology from the Code ID.
    await actions.listen({});
    assertEquals(honeywell.state().mode, "listening");
    actions.simulate({ code: "boarding-pass" });
    await settle(() => honeywell.state().barcode !== null);
    assertEquals(honeywell.state().barcode?.symbology, "PDF417");
    assert(honeywell.state().barcode?.text.startsWith("M1TESTER/MOCK"));
    actions.simulate({ code: "qr" });
    await settle(() => honeywell.state().barcode?.symbology === "QR Code");
    assertEquals(honeywell.state().barcode?.symbology, "QR Code");

    // Commands wait for the read loop to stop.
    await assertRejects(() => Promise.resolve(actions.identity({})), Error, "Stop reading first");
    await actions.stop({});
    assertEquals(honeywell.state().mode, "idle");

    // A single triggered read ends at the first decode.
    await assertRejects(() => Promise.resolve(actions["single-read"]({ seconds: 99 })), Error, "seconds");
    await actions["single-read"]({ seconds: 5 });
    assertEquals(honeywell.state().mode, "single");
    actions.simulate({ code: "boarding-pass" });
    await settle(() => honeywell.state().mode === "idle");
    assertEquals(honeywell.state().barcode?.symbology, "PDF417");

    // Settings are read back from the scanner.
    await actions.beeper({ on: false, volume: 1 });
    assertEquals(honeywell.state().beeper, { on: false, volume: 1 });
    await assertRejects(() => Promise.resolve(actions.beeper({ volume: 7 })), Error, "volume");

    const { identity } = await actions.identity({}) as { identity: { label: string; value: string }[] };
    assertEquals(identity.find((field) => field.label === "Software Revision")?.value, "1.02");
    assertEquals(identity.find((field) => field.label === "Product Name")?.value, "5X80 Mock Scanner");

    assertThrows(() => actions.simulate({ code: "nope" }), Error, "unknown code");
  }
  finally {
    await honeywell.disconnect();
  }
  assertEquals(honeywell.state().status, "closed");
  assertEquals(honeywell.state().barcode, null);
  await honeywell.disconnect(); // idempotent

  // Nothing saved to flash: every command went with "!", never ".".
  assert(honeywell.mockCommands.length > 0);
  assertEquals(honeywell.mockCommands.filter((command) => !command.endsWith("!")), []);
  // The kiosk's own prefix and suffix, read at connect, are put back on disconnect.
  assertEquals(honeywell.mockCommands[0], "PREBK2?;SUFBK2?!");
  assertEquals(honeywell.mockCommands.at(-1), "TRGMOD0;PRECA2;SUFCA2;PREBK29902;SUFBK29903!");
});

Deno.test("a 5X80 unplugged while listening is reported lost", async () => {
  honeywell.configure({ mock: true });
  await honeywell.connect();
  try {
    await actions.listen({});
    actions.simulate({ code: "unplug" });
    await settle(() => honeywell.state().status === "closed");
    assertEquals(honeywell.state().status, "closed");
    assertEquals(honeywell.state().mode, "idle");
    await assertRejects(() => Promise.resolve(actions.identity({})), Error, "Not connected");
  }
  finally {
    await honeywell.disconnect();
  }
});

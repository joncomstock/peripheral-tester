import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import * as datalogic from "./datalogic.ts";

const until = async (done: () => boolean) => {
  for (let i = 0; i < 50 && !done(); i++) await new Promise((r) => setTimeout(r, 20));
};

Deno.test("the mock Gryphon reads, triggers, configures and identifies through the real driver", async () => {
  datalogic.configure({ mock: true });
  await datalogic.connect();
  const { actions } = datalogic;
  try {
    assertEquals(datalogic.state().status, "open");
    assertEquals(datalogic.state().usbId, "05f9:4204");
    assertThrows(() => datalogic.configure({ mock: false }), Error, "Disconnect before changing mode");

    // Idle, the scanner decodes nothing.
    assertThrows(() => actions.simulate({ code: "qr" }), Error, "not reading");

    // Presentation: a boarding pass, then a QR code, each split from its AIM identifier.
    await actions.listen({});
    assertEquals(datalogic.state().reading, "presentation");
    actions.simulate({ code: "boarding-pass" });
    await until(() => datalogic.state().barcode !== null);
    assertEquals(datalogic.state().barcode?.symbology, "]L2");
    assertEquals(datalogic.state().barcode?.text.startsWith("M1SAMPLE/TEST"), true);
    actions.simulate({ code: "qr" });
    await until(() => datalogic.state().barcode?.symbology === "]Q1");
    assertEquals(datalogic.state().barcode?.text, "https://example.com/not-a-real-ticket");

    // Commands wait for reading to stop.
    await assertRejects(async () => await actions.identity({}), Error, "Stop reading first");
    await actions.stop({});
    assertEquals(datalogic.state().reading, null);

    // A single read that decodes, and one that times out.
    const read = actions.trigger({ seconds: 2 }) as Promise<{ decoded: boolean }>;
    await until(() => datalogic.state().reading === "single");
    actions.simulate({ code: "boarding-pass" });
    assertEquals(await read, { decoded: true });
    assertEquals(datalogic.state().reading, null);
    assertEquals(await actions.trigger({ seconds: 1 }), { decoded: false });
    await assertRejects(async () => await actions.trigger({ seconds: 0 }), Error, "1 to 255");

    await actions.symbologies({ codes: ["QR", "PDF417"] });
    assertEquals(datalogic.state().enabled, ["PDF417", "QR"]);
    await assertRejects(async () => await actions.symbologies({ codes: ["EAN13"] }), Error, "codes must be");

    actions.presentation({ mode: "AUTOMATIC" });
    assertEquals(datalogic.state().presentationMode, "AUTOMATIC");
    assertThrows(() => actions.presentation({ mode: "ON_LINE" }), Error, "mode must be");
    actions.presentation({ mode: "OBJECT_SENSE" });

    assertEquals(((await actions.identity({})) as { firmware: string }).firmware.startsWith("Gryphon-GFS4470"), true);
    assertThrows(() => actions.simulate({ code: "nope" }), Error, "code must be");
  }
  finally {
    await datalogic.disconnect();
  }
  assertEquals(datalogic.state().status, "closed");
  assertEquals(datalogic.state().barcode, null);
  await datalogic.disconnect(); // idempotent
});

Deno.test("datalogic: a scanner unplugged while listening closes the session", async () => {
  datalogic.configure({ mock: true });
  await datalogic.connect();
  try {
    await datalogic.actions.listen({});
    datalogic.actions.simulate({ code: "unplug" });
    await until(() => datalogic.state().status === "closed");
    assertEquals([datalogic.state().status, datalogic.state().reading], ["closed", null]);
  }
  finally {
    await datalogic.disconnect();
  }
});

Deno.test("datalogic: a second read is refused while the first is still configuring", async () => {
  datalogic.configure({ mock: true });
  await datalogic.connect();
  try {
    const first = datalogic.actions.trigger({ seconds: 1 }) as Promise<{ decoded: boolean }>;
    await assertRejects(async () => await datalogic.actions.trigger({ seconds: 1 }), Error, "Stop reading first");
    await assertRejects(async () => await datalogic.actions.listen({}), Error, "Stop reading first");
    assertEquals(await first, { decoded: false });
  }
  finally {
    await datalogic.disconnect();
  }
});

Deno.test("datalogic: disconnect puts every symbology back", async () => {
  datalogic.configure({ mock: true });
  await datalogic.connect();
  await datalogic.actions.symbologies({ codes: ["QR"] });
  await datalogic.disconnect();
  // The mock's settings outlive the session, as the scanner's RAM does: the next one decodes PDF417.
  await datalogic.connect();
  try {
    await datalogic.actions.listen({});
    datalogic.actions.simulate({ code: "boarding-pass" });
    await until(() => datalogic.state().barcode !== null);
    assertEquals(datalogic.state().barcode?.symbology, "]L2");
  }
  finally {
    await datalogic.disconnect();
  }
});

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { delay } from "@std/async";
import { history } from "./activity.ts";
import * as itk38 from "./itk38.ts";

/** The mock streams status every half second; wait for the next one to show a change. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 40 && !check(); i++) await delay(50);
  assert(check(), "state never changed");
}

const flags = () => itk38.state().printer!.flags;

Deno.test("the mock ITK 38 reports paper and documents, prints, and answers its controls", async () => {
  itk38.configure({ mock: true });
  await itk38.connect();
  try {
    const state = itk38.state();
    assertEquals([state.status, state.usbId], ["open", "1201:4954"]);
    assertEquals(state.printer?.firmwareVersion, "V3.05S.MOCK");
    assertEquals([state.printer?.temperature, state.printer?.formLength, state.printer?.documentCount], [25, 325, 0]);
    assertThrows(() => itk38.configure({ mock: false }), Error, "Disconnect before changing mode");

    assertEquals(await itk38.actions.identity({}), { serial: "MOCK0000ITK38001", firmware: "V3.05S.MOCK" });

    // A print reaches the end-of-page command: the count rises and the document waits to be taken.
    await itk38.actions.print({});
    await until(() => itk38.state().printer!.documentCount === 1);
    assert(flags().documentNotTaken);
    await itk38.actions.eject({});
    await itk38.actions.dispose({});
    await until(() => flags().documentDisposed && !flags().documentNotTaken);
    await itk38.actions.print({});
    await until(() => flags().documentNotTaken);
    itk38.actions.simulate({ event: "take" });
    await until(() => !flags().documentNotTaken);

    // Low paper still prints; out of paper, a jam or an open head is refused before any job is sent.
    itk38.actions.simulate({ event: "paper-low" });
    await until(() => flags().lowPaper);
    await itk38.actions.print({});
    await until(() => itk38.state().printer!.documentCount === 3);
    for (const [event, flag] of [["paper-out", "outOfPaper"], ["jam", "paperError"], ["lever-up", "headLeverUp"]] as const) {
      itk38.actions.simulate({ event });
      await until(() => flags()[flag]);
      await assertRejects(async () => await itk38.actions.print({}), Error, flag);
    }
    itk38.actions.simulate({ event: "lever-down" });
    itk38.actions.simulate({ event: "paper-ok" });
    await until(() => !flags().headLeverUp && !flags().paperError && !flags().outOfPaper && !flags().lowPaper);
    assertThrows(() => itk38.actions.simulate({ event: "fire" }), Error, "event must be one of");

    // Pulling the cable closes the session. Every read after fails "not open"; that is said once, not per retry.
    const errors = () => history().filter((e) => e.device === "itk38" && e.kind === "error").length;
    const before = errors();
    itk38.actions.simulate({ event: "unplug" });
    await until(() => itk38.state().status === "closed");
    assertEquals(itk38.state().printer, null);
    await delay(300);
    assertEquals(errors() - before, 1);
  }
  finally {
    await itk38.disconnect();
  }
  assertEquals(itk38.state().status, "closed");
  assertThrows(() => itk38.actions.simulate({ event: "take" }), Error, "Only a mock printer");
  itk38.configure({ mock: false });
});

// The driver's own open helper leaves the transport open when the first status times out.
Deno.test("a mock ITK 38 that never answers fails to connect and is closed", async () => {
  itk38.configure({ mock: true });
  itk38.mockFaults.silent = true;
  try {
    await assertRejects(() => itk38.connect());
  }
  finally {
    itk38.mockFaults.silent = false;
  }
  assertEquals(itk38.state().status, "closed");
  assertEquals(itk38.mockFaults.transport?.isOpen, false);
  // Nothing was left half-open: a retry opens cleanly.
  await itk38.connect();
  assertEquals(itk38.state().status, "open");
  await itk38.disconnect();
  itk38.configure({ mock: false });
});

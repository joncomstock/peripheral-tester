import { assert, assertEquals, assertRejects } from "@std/assert";
import * as k8 from "./k8.ts";

Deno.test("the mock K8 identifies, prints, reports paper faults and loses its link", async () => {
  k8.configure({ mock: true });
  await k8.connect();
  try {
    assertEquals(k8.state().status, "open");
    assertEquals(k8.state().usbId, "0404:040f");
    assertEquals(k8.state().identity?.model, "497-0466327");
    assertEquals(k8.state().identity?.firmware, "00.87");
    assertEquals(k8.state().config?.density, -4);
    assertEquals(k8.state().paper?.faults, []);

    await k8.actions["print-test"]({});
    assertEquals(k8.state().paper?.faults, []);

    await k8.actions.simulate({ action: "paper-low" });
    assert(k8.state().paper?.set.includes("paperLow"));
    // Paper low is a warning, not a fault: the page still prints.
    await k8.actions["print-test"]({});

    await k8.actions.simulate({ action: "paper-out" });
    assert(k8.state().paper?.faults.includes("paper out"));
    await assertRejects(async () => await k8.actions["print-test"]({}), Error, "paper out");

    await k8.actions.simulate({ action: "jam" });
    assert(k8.state().paper?.faults.includes("paper jam"));
    await k8.actions.simulate({ action: "clear" });
    await k8.actions.recover({});
    assertEquals(k8.state().paper?.faults, []);

    await assertRejects(async () => await k8.actions.simulate({ action: "fire" }), Error, "not a simulation");

    await assertRejects(async () => await k8.actions.simulate({ action: "unplug" }), Error, "lost");
    assertEquals(k8.state().status, "closed");
    assertEquals(k8.state().identity, null);
  }
  finally {
    await k8.disconnect();
  }
  assertEquals(k8.state().status, "closed");
});

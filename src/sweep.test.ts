import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "./api.ts";

/**
 * The API client is replaced wholesale, because the point of these tests is what the sweep *does*
 * to the devices — which calls it makes and in what order — not what a backend answers.
 */
vi.mock("./api.ts", () => ({
  getSnapshot: vi.fn(),
  lightboard: { connect: vi.fn(), disconnect: vi.fn() },
  cardreader: { connect: vi.fn(), disconnect: vi.fn() },
  passportreader: { connect: vi.fn(), disconnect: vi.fn() },
}));

const api = await import("./api.ts") as unknown as {
  getSnapshot: ReturnType<typeof vi.fn>;
  lightboard: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
  cardreader: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
  passportreader: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };
};

const { handshake, runSweep } = await import("./sweep.ts");
const { WIRED } = await import("./devices.ts");

/** Only the fields the sweep reads. The rest of a `Snapshot` is irrelevant to it. */
const snapshotWith = (
  { board = "closed", card = "closed", passport = "closed", portName = "COM14" }: {
    board?: string;
    card?: string;
    passport?: string;
    portName?: string;
  } = {},
) =>
  ({
    lightboard: { status: board, portName },
    cardreader: { status: card },
    passportreader: { status: passport, device: undefined, api: undefined },
  }) as unknown as Snapshot;

beforeEach(() => {
  vi.clearAllMocks();
  api.getSnapshot.mockResolvedValue(snapshotWith());
  for (const device of [api.lightboard, api.cardreader, api.passportreader]) {
    device.connect.mockResolvedValue({ ok: true });
    device.disconnect.mockResolvedValue({ ok: true });
  }
});

describe("handshake", () => {
  it("opens a closed device and puts it back", async () => {
    const result = await handshake("cardreader", snapshotWith());
    expect(result.pass).toBe(true);
    expect(api.cardreader.connect).toHaveBeenCalledOnce();
    expect(api.cardreader.disconnect).toHaveBeenCalledOnce();
  });

  it("leaves a device the operator already has open alone", async () => {
    // The behaviour, not the wording: reopening means closing first, which would darken a board
    // somebody is standing in front of.
    const result = await handshake("lightboard", snapshotWith({ board: "open" }));
    expect(result.pass).toBe(true);
    expect(api.lightboard.connect).not.toHaveBeenCalled();
    expect(api.lightboard.disconnect).not.toHaveBeenCalled();
  });

  it("fails the light board without opening anything when no port is set", async () => {
    const result = await handshake("lightboard", snapshotWith({ portName: "   " }));
    expect(result.pass).toBe(false);
    expect(result.detail).toBe("No port set");
    expect(api.lightboard.connect).not.toHaveBeenCalled();
  });

  it("reports a refusal as a result rather than throwing, and releases the half-open handle", async () => {
    api.cardreader.connect.mockRejectedValue(new Error("interface claim refused"));
    const result = await handshake("cardreader", snapshotWith());
    expect(result.pass).toBe(false);
    expect(result.detail).toBe("interface claim refused");
    // A handle left half-open would block the operator's own connect afterwards.
    expect(api.cardreader.disconnect).toHaveBeenCalledOnce();
  });

  it("survives a disconnect that also refuses, so one broken device cannot end the sweep", async () => {
    api.passportreader.connect.mockRejectedValue(new Error("PageScanAPI.dll not found"));
    api.passportreader.disconnect.mockRejectedValue(new Error("nothing to release"));
    await expect(handshake("passportreader", snapshotWith())).resolves.toMatchObject({ pass: false });
  });
});

describe("runSweep", () => {
  it("handshakes every wired device in turn and reports each as it lands", async () => {
    const order: string[] = [];
    const results: string[] = [];
    await runSweep(
      WIRED,
      () => snapshotWith(),
      (id) => results.push(id),
      (id) => id && order.push(id),
    );
    expect(results).toEqual(["lightboard", "cardreader", "passportreader"]);
    expect(order).toEqual(["lightboard", "cardreader", "passportreader"]);
  });

  it("clears the active device at the end, so nothing is left showing as mid-handshake", async () => {
    const active: (string | null)[] = [];
    await runSweep(WIRED, () => snapshotWith(), () => {}, (id) => active.push(id));
    expect(active[active.length - 1]).toBeNull();
  });

  it("sweeps only the devices it was given, so a rail without the card reader never opens one", async () => {
    const swept: string[] = [];
    await runSweep(["lightboard"], () => snapshotWith(), (id) => swept.push(id), () => {});
    expect(swept).toEqual(["lightboard"]);
    expect(api.cardreader.connect).not.toHaveBeenCalled();
  });

  it("carries on past a device that refused", async () => {
    api.lightboard.connect.mockRejectedValue(new Error("COM14 is held by another process"));
    const passed: boolean[] = [];
    await runSweep(WIRED, () => snapshotWith(), (_id, result) => passed.push(result.pass), () => {});
    expect(passed).toEqual([false, true, true]);
  });
});

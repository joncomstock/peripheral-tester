import { beforeEach, describe, expect, it, vi } from "vitest";
import { recall, remember } from "./prefs.ts";

/**
 * A kiosk browser with site data disabled throws on access rather than returning null, which is
 * the case these guards exist for — a tester that will not start because it could not remember a
 * colour is worse than one that forgets.
 */
const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
});

const isColour = (v: string): v is "red" | "blue" => v === "red" || v === "blue";

describe("remembering a preference", () => {
  it("gives back what was written", () => {
    remember("colour", "blue");
    expect(recall("colour", "red", isColour)).toBe("blue");
  });

  it("namespaces the key, so it cannot collide with another app on the same origin", () => {
    remember("colour", "blue");
    expect([...store.keys()]).toEqual(["peripheral-tester:colour"]);
  });

  it("falls back when nothing was written", () => {
    expect(recall("colour", "red", isColour)).toBe("red");
  });

  /**
   * The behaviour, not the metadata: what comes back was written by an older build of this app, so
   * a device id that no longer exists would otherwise put the shell on a screen that cannot render.
   */
  it("rejects a value an older build wrote that is no longer valid", () => {
    store.set("peripheral-tester:colour", "chartreuse");
    expect(recall("colour", "red", isColour)).toBe("red");
  });

  it("falls back rather than throwing when storage refuses to be read", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("The operation is insecure.");
      },
      setItem: () => {},
    });
    expect(recall("colour", "red", isColour)).toBe("red");
  });

  it("does not throw when storage refuses to be written", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => remember("colour", "blue")).not.toThrow();
  });
});

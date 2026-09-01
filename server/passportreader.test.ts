import { assertEquals } from "@std/assert";
import { configure, connect, disconnect, image, read, scan, state } from "./passportreader.ts";
import { forWire } from "./passportreader.ts";

/**
 * The driver's `BarcodeRead`, as it arrives: bytes plus the latin-1 view of them.
 *
 * Built the way the driver builds it rather than hand-written, so the relationship between `data`
 * and `text` under test is the real one.
 */
function fromDriver(data: Uint8Array) {
  return {
    found: true,
    symbologyCode: "]C",
    symbology: "Code 128",
    data,
    text: new TextDecoder("latin1").decode(data),
  };
}

Deno.test("byteLength counts bytes, for a payload where characters would also be bytes", () => {
  const data = new TextEncoder().encode("M1ERIKSSON/ANNA");
  assertEquals(forWire(fromDriver(data)).byteLength, data.length);
});

Deno.test("byteLength counts bytes for high and NUL bytes, which a barcode may carry", () => {
  // 0x00 because the vendor header warns the payload may contain any binary, and 0x80-0xff because
  // those are the bytes a character count would disagree with under any decode but latin-1.
  const data = new Uint8Array([0x41, 0x00, 0x80, 0xc3, 0xa9, 0xff]);
  const wire = forWire(fromDriver(data));
  assertEquals(wire.byteLength, 6);
  // Not 5: `c3 a9` is two bytes, and is one character only if something decodes it as UTF-8.
  assertEquals(wire.byteLength, data.length);
});

Deno.test("a binary payload crosses as hex, because the text cannot carry it", () => {
  // The driver renders through windows-1252, so 0x80 becomes U+20AC and cannot be read back as a
  // byte. Without hex, a binary barcode would reach the page as mojibake and nothing else.
  const data = new Uint8Array([0x00, 0x7f, 0x80, 0xff]);
  const wire = forWire(fromDriver(data));
  assertEquals(wire.hex, "00 7f 80 ff");
  assertEquals(wire.byteLength, 4);
});

Deno.test("a printable payload carries no hex, so a boarding pass is not sent twice", () => {
  const wire = forWire(fromDriver(new TextEncoder().encode("M1ERIKSSON/ANNA  EABC123")));
  assertEquals(wire.hex, undefined);
});

Deno.test("a field added to the driver's read reaches the wire rather than being dropped", () => {
  // The spread is what makes this true; respelling each field by hand is what made it false.
  const read = { ...fromDriver(new Uint8Array([1])), aimId: "]C0" };
  const wire: Record<string, unknown> = { ...forWire(read) };
  assertEquals(wire.aimId, "]C0");
});

Deno.test("the raw bytes do not cross the wire", () => {
  // They would serialise as an object of numeric keys, which is neither the bytes nor useful.
  assertEquals("data" in forWire(fromDriver(new Uint8Array([1, 2]))), false);
});

/**
 * The page and the MRZ have to come from one presentation.
 *
 * `readDocument`'s own comment is explicit: the API's "last scan" is one piece of state inside the
 * DLL, so an image fetched after the read returns encodes whatever was scanned most recently — on a
 * busy unit, the next traveller's document attached to this one's MRZ. Requesting it inside the read
 * is what makes the pairing a guarantee rather than a race.
 */
Deno.test("a read encodes its page under the same lock as its MRZ", async () => {
  configure({ mock: true });
  await connect();
  try {
    const result = await read();
    assertEquals(result.image?.region, "document");
    assertEquals(result.image!.byteLength > 0, true);
  }
  finally {
    await disconnect();
  }
});

Deno.test("a read leaves its page held, so the frame needs no second click", async () => {
  configure({ mock: true });
  await connect();
  try {
    await read();
    assertEquals(state().imageHeld, true);
  }
  finally {
    await disconnect();
  }
});

/**
 * The held page belongs to the read that produced it and to nothing else.
 *
 * A later `scan()` replaces the DLL's "last scan", so the page from the earlier read is no longer
 * what the device is holding. Serving it on after that is the stale pairing this whole change
 * exists to prevent — a page from one presentation beside an MRZ from another.
 */
Deno.test("a later scan drops the held page rather than serving it on", async () => {
  configure({ mock: true });
  await connect();
  try {
    await read();
    await scan();
    assertEquals(state().imageHeld, false);
  }
  finally {
    await disconnect();
  }
});

Deno.test("with no page held the image call still encodes, which is the granular path", async () => {
  configure({ mock: true });
  await connect();
  try {
    await scan();
    assertEquals(state().imageHeld, false);
    const encoded = await image("visible", "bmp", "document");
    assertEquals(encoded.bytes.length > 0, true);
  }
  finally {
    await disconnect();
  }
});

Deno.test("releasing the scanner drops the held page with it", async () => {
  configure({ mock: true });
  await connect();
  await read();
  await disconnect();
  // A page outliving the session it came from could be served against a different device entirely.
  assertEquals(state().imageHeld, false);
});

import { describe, expect, it } from "vitest";
import { maskMrzLine } from "./PassportReaderPage.tsx";
import type { MrzRead } from "./api.ts";

/**
 * The ICAO 9303 specimen passport, which is also what mock mode returns.
 *
 * A `TD3` read: two lines of 44, so `parseMrz` recognises the layout and hands back fields.
 */
const LINES = [
  "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<",
  "L898902C36UTO7408122F1204159ZE184226B<<<<<10",
];

const FIELDS = {
  documentNumber: "L898902C3",
  dateOfBirth: { raw: "740812", iso: "1974-08-12" },
} as unknown as NonNullable<MrzRead["fields"]>;

describe("masking a machine-readable zone", () => {
  it("blanks the document number and the birth date where they appear inline", () => {
    const masked = maskMrzLine(LINES[1], FIELDS);
    expect(masked).not.toContain("L898902C3");
    expect(masked).not.toContain("740812");
  });

  it("leaves the rest of a parsed line readable, which is the point of showing it", () => {
    // The issuing state and the expiry are not personal data and are what the zone is read for.
    expect(maskMrzLine(LINES[1], FIELDS)).toContain("UTO");
    expect(maskMrzLine(LINES[1], FIELDS)).toContain("120415");
    expect(maskMrzLine(LINES[0], FIELDS)).toBe(LINES[0]);
  });

  it("keeps a parsed line the same length, so the columns still line up", () => {
    for (const line of LINES) expect(maskMrzLine(line, FIELDS).length).toBe(line.length);
  });

  /**
   * The other case mock mode cannot produce: one glyph of the document number misread as a filler.
   *
   * `parseMrz` runs every field through `trimFiller`, which turns an interior `<` into a space —
   * so the parsed number never equals the characters it was read from, and a plain `replaceAll`
   * blanks nothing. The line length is unchanged by a character-level misread, so the layout still
   * parses and the blanket-blank path does not catch it either.
   */
  describe("when a glyph inside the document number came back as a filler", () => {
    const MISREAD = "L8989<2C36UTO7408122F1204159ZE184226B<<<<<10";
    const TRIMMED = { ...FIELDS, documentNumber: "L8989 2C3" } as NonNullable<MrzRead["fields"]>;

    it("still blanks the number", () => {
      const masked = maskMrzLine(MISREAD, TRIMMED);
      expect(masked).not.toContain("L8989<2C3");
      expect(masked.startsWith("•••••••••")).toBe(true);
    });

    it("blanks it without changing the length, so the columns still line up", () => {
      expect(maskMrzLine(MISREAD, TRIMMED).length).toBe(MISREAD.length);
    });

    it("still blanks the birth date beside it", () => {
      expect(maskMrzLine(MISREAD, TRIMMED)).not.toContain("740812");
    });
  });

  /**
   * The case that cannot happen in mock mode.
   *
   * The driver reports `recognized: true` for any good OCR read, but `parseMrz` returns
   * `undefined` unless the line lengths are 3×30, 2×44 or 2×36. A short or garbled pass lands
   * there — and blanking "the known secrets" blanks nothing, because none are known.
   */
  describe("when the layout was not parsed", () => {
    const GARBLED = "L8989*2C36UTO7408122F12041";

    it("blanks the whole line rather than nothing at all", () => {
      const masked = maskMrzLine(GARBLED, undefined);
      expect(masked).not.toContain("740812");
      expect(masked).not.toMatch(/[A-Z0-9*]/);
    });

    it("keeps the filler characters, so the shape still says how long the read came back", () => {
      // Length is the diagnostic that matters when the layout is what failed.
      const short = "P<UTOERIKSSON<<ANNA<<<";
      const masked = maskMrzLine(short, undefined);
      expect(masked.length).toBe(short.length);
      expect(masked).toBe("•<•••••••••••<<••••<<<");
    });
  });
});

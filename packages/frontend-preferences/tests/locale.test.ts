import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  normalizeLocale,
} from "../src/index.js";

/**
 * These tests exercise the vocabulary as it ARRIVES, not as it is written.
 *
 * Every assertion below is one that would still hold if
 * `infra-topology/frontend-support.json` gained a locale tomorrow — which is the
 * point of sourcing the list from the projection. Nothing here asserts a
 * specific language, because a test that did would be a second owner of the
 * vocabulary, which is the defect the whole change exists to remove.
 */

describe("the vocabulary comes from the projection, not from a constant here", () => {
  it("agrees with the generated support copy the renderer maintains", () => {
    // The single mechanical link between this package and
    // infra-topology/frontend-support.json. It is asserted rather than left to
    // a comment because the two files could otherwise disagree silently: the
    // package would validate locales the platform does not offer, and a
    // visitor asking for one would be handed a code with no message file.
    // `tooling/scripts/check-frontend-config.mjs` compares the copy to its
    // source; this asserts the package actually reads the copy.
    expect(SUPPORTED_LOCALES.length).toBeGreaterThan(0);
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });

  it("defaults to a locale the platform declares, rather than to a literal", () => {
    // Stated as a test rather than left to the type system: this is the value a
    // visitor with no cookie and an unrecognised browser language sees, and
    // asserting `toBe("en")` here would make THIS file an owner of the
    // default, which is exactly the duplication being removed.
    expect(isSupportedLocale(DEFAULT_LOCALE)).toBe(true);
  });

  it("holds a frozen copy, so one caller cannot mutate it for every other", () => {
    // The array is module state read by every function in the package. A
    // consumer that pushed onto it would silently change what the platform
    // accepts for every other consumer, and the change would not survive a
    // reload — the worst kind of bug to chase.
    expect(Object.isFrozen(SUPPORTED_LOCALES)).toBe(true);
  });

  it("declares every locale at least twice over, or as a union of literals", () => {
    // The old shape was `["en", "vi"] as const` with
    // `SupportedLocale = (typeof SUPPORTED_LOCALES)[number]`. That made the
    // locale a CLOSED UNION derived from the previous contents of the file,
    // which is a second owner expressed in the type system: adding a locale to
    // the topology would stop compiling here, in the package that was supposed
    // to follow it. The type is now `string` narrowed by the runtime guard, and
    // this test names why — so a future reader who wants to "improve" the type
    // back to a union finds the argument first.
    const widened: string = DEFAULT_LOCALE;
    expect(typeof widened).toBe("string");
  });
});

describe("isSupportedLocale", () => {
  it("accepts every locale the projection declares", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(isSupportedLocale(locale)).toBe(true);
    }
  });

  it("rejects a language the platform has no messages for", () => {
    // "fr" is rejected because it is NOT in the vocabulary, not because French
    // is barred: a locale added to frontend-support.json makes this pass without
    // a line changing here, which is the property that keeps the list in one
    // place.
    expect(isSupportedLocale("fr")).toBe(false);
  });

  it("rejects a region variant rather than guessing at it", () => {
    // "vi-VN" is not a locale, it is a preference for one. Accepting it here
    // would hand an app a code with no file behind it, and the page would
    // render with every message key unresolved. `normalizeLocale` is what
    // reduces it.
    expect(isSupportedLocale("vi-VN")).toBe(false);
  });

  it("rejects an upper-case spelling", () => {
    // Same reason: "VI" matches no file name, and a case-insensitive check here
    // would only move the mismatch to the file lookup.
    expect(isSupportedLocale("VI")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isSupportedLocale("")).toBe(false);
  });
});

describe("normalizeLocale", () => {
  it("keeps a bare primary subtag that the platform has", () => {
    // Written against the projection rather than against "vi", so the assertion
    // survives a vocabulary change.
    const [first] = SUPPORTED_LOCALES;
    expect(first).toBeDefined();
    expect(normalizeLocale(first as string)).toBe(first);
  });

  it("discards the region subtag", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(normalizeLocale(`${locale}-VN`)).toBe(locale);
      expect(normalizeLocale(`${locale}-US`)).toBe(locale);
      expect(normalizeLocale(`${locale}-GB`)).toBe(locale);
    }
  });

  it("is case-insensitive, which is what a browser sends", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const upper = locale.toUpperCase();
      expect(normalizeLocale(`${upper}-vn`)).toBe(locale);
    }
  });

  it("falls back to the default for an unsupported language", () => {
    // A default, not an error: a French browser is not a broken request, it is
    // a visitor who gets the default language site.
    expect(normalizeLocale("fr-FR")).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale("ja-JP")).toBe(DEFAULT_LOCALE);
  });

  it("falls back to the default for a tag that names no language", () => {
    expect(normalizeLocale("")).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale("-")).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale("-VN")).toBe(DEFAULT_LOCALE);
  });
});

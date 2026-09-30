import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  normalizeLocale,
} from "../src/index.js";

describe("the platform's locale vocabulary", () => {
  it("defaults to English", () => {
    // Stated as a test rather than left to the type system: this is the value a
    // visitor with no cookie and an unrecognised browser language sees, and
    // changing it silently re-labels the entire platform's fallback.
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("lists the default first, so the array order and the fallback agree", () => {
    expect(SUPPORTED_LOCALES[0]).toBe(DEFAULT_LOCALE);
  });
});

describe("isSupportedLocale", () => {
  it("accepts every locale the platform declares", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(isSupportedLocale(locale)).toBe(true);
    }
  });

  it("rejects a language the platform has no messages for", () => {
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
  it("keeps a bare primary subtag", () => {
    expect(normalizeLocale("vi")).toBe("vi");
  });

  it("discards the region subtag", () => {
    expect(normalizeLocale("vi-VN")).toBe("vi");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("en-GB")).toBe("en");
  });

  it("is case-insensitive, which is what a browser sends", () => {
    expect(normalizeLocale("VI-vn")).toBe("vi");
    expect(normalizeLocale("EN-us")).toBe("en");
  });

  it("falls back to the default for an unsupported language", () => {
    // A default, not an error: a French browser is not a broken request, it is
    // a visitor who gets the English site.
    expect(normalizeLocale("fr-FR")).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale("ja-JP")).toBe(DEFAULT_LOCALE);
  });

  it("falls back to the default for a tag that names no language", () => {
    expect(normalizeLocale("")).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale("-")).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale("-VN")).toBe(DEFAULT_LOCALE);
  });
});

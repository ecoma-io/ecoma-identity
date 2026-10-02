import type { SupportedLocale } from "./config.js";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./config.js";

/**
 * Narrowing a string to a locale the platform actually has.
 *
 * A type guard rather than a cast, because the value being narrowed is
 * attacker-adjacent: it comes out of a cookie a visitor can edit, or out of
 * `navigator.languages`, and a cast would have the cookie reader return `"fr"`
 * typed as a `SupportedLocale` and hand the app a locale with no message file
 * behind it. The failure then surfaces as a blank page rather than as a
 * fallback.
 *
 * The comparison is exact, so an upper-case `"VI"` or a region variant
 * `"vi-VN"` is **not** a locale. Both are the caller's job to reduce first —
 * see {@link normalizeLocale} — and quietly accepting them here would mean two
 * different spellings of the same language, only one of which matches a file
 * name in an app's `locales/` directory.
 *
 * ## Why the list is read, not written
 *
 * This used to test membership in a `SUPPORTED_LOCALES` constant declared two
 * files away, and that constant was the *second* owner of a fact
 * `infra-topology/frontend-support.json` owns. Nothing tied the two together:
 * changing the topology's vocabulary would have left the TypeScript list
 * standing, and a locale the platform advertised while the package rejected it
 * is a visitor seeing raw message keys with every test green. The list now
 * arrives through the generated projection, so adding a locale is one edit in
 * one file and the package agrees with it by construction.
 *
 * @param locale The string to test.
 * @returns Whether the platform has messages for it.
 */
export function isSupportedLocale(locale: string): locale is SupportedLocale {
  return SUPPORTED_LOCALES.includes(locale);
}

/**
 * Reduce a BCP 47 language tag to one of the platform's locales.
 *
 * `vi-VN` → `vi`, `en-GB` → `en`, `fr-FR` → `en`. The platform's locales are
 * primary subtags, because that is what a message file can be named after, so
 * everything after the first `-` is discarded rather than compared.
 *
 * The default is read from the projection rather than hardcoded, which is what
 * keeps `fr-FR` landing on whatever `infra-topology/frontend-support.json` says
 * the platform's fallback is. It was `"en"` as a literal here before, and a
 * literal here was a second owner of it.
 *
 * @param languageTag An `Accept-Language` entry, a `navigator.languages` entry,
 *   or any other tag-shaped string.
 * @returns The matching locale, or the default when the language is not one the
 *   platform has.
 *
 * @example
 * ```ts
 * normalizeLocale("vi-VN")  // "vi"
 * normalizeLocale("en-US")  // "en"
 * normalizeLocale("fr-FR")  // "en" — the default, not a failure
 * ```
 */
export function normalizeLocale(languageTag: string): SupportedLocale {
  const primary = languageTag.split("-")[0]?.toLowerCase();

  // `""` and `"-"` both reach here as an empty or missing segment. Returning
  // the default is the honest answer for a tag that names no language.
  if (primary === undefined || primary === "") {
    return DEFAULT_LOCALE;
  }

  return isSupportedLocale(primary) ? primary : DEFAULT_LOCALE;
}

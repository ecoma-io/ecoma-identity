import type { CookiePolicy, SupportedLocale } from "./config.js";
import { DEFAULT_LOCALE } from "./config.js";
import {
  readPreferenceLocale,
  removePreferenceCookie,
  setPreferenceLocale,
  type PreferenceStorage,
} from "./preference-cookie.js";
import { isSupportedLocale } from "./locale.js";

/**
 * The locale preference: reading, writing, and detecting it.
 *
 * ## Why this file writes `document.cookie` itself
 *
 * It no longer does — the attribute string and the encode/decode live in
 * `preference-cookie.ts`, which owns both browser-side preferences because they
 * share one cookie. What this file owns is the ORDER: cookie, then browser, then
 * the platform default, and the rule that the order is the same in all three
 * frontends.
 *
 * ## Why no cookie library
 *
 * The whole surface is one cookie with no encoding library, no signing and no
 * expiry parsing: `universal-cookie` is ~4 kB of package and a dependency that
 * `AGENTS.md` would want an architectural justification for, in exchange for
 * solving a problem this file does not have.
 *
 * ## Why `SameSite=Lax` and not `None`
 *
 * The three apps are separate origins reached by top-level navigation, not
 * embedded. `Lax` permits exactly that and blocks the cookie on cross-site
 * subresource requests, which is the only thing that would matter if the value
 * were a credential. It is not: the value is a language code, and the worst an
 * attacker who could set it is a page in the wrong language.
 *
 * `None` would require `Secure` and would additionally make the cookie readable
 * from a cross-origin iframe embedding any of these apps — a strictly larger
 * surface for a strictly less useful guarantee.
 */

/**
 * Narrowing an untrusted string to a locale the platform has.
 *
 * Re-exported through this module because a caller reading a cookie thinks in
 * terms of "the locale", not of "the first part of a shared cookie value", and
 * two names for one guard is how a validation gets skipped on one path.
 */
export { isSupportedLocale };

/**
 * Write the locale preference.
 *
 * The colour mode already in the cookie is preserved rather than cleared —
 * `preference-cookie.ts` owns that detail — so a visitor changing their language
 * does not silently lose the theme they chose.
 *
 * @param locale The locale to remember.
 * @param policy Where the cookie lives. Defaults to this build's projection; pass
 *   one explicitly when the caller already holds a config, so that a write and a
 *   delete cannot disagree.
 */
export function setLocaleCookie(
  locale: SupportedLocale,
  policy?: PreferenceStorage | CookiePolicy,
): void {
  setPreferenceLocale(locale, policy);
}

/**
 * Read the locale preference.
 *
 * Takes no policy beyond the name, and the absence of everything else is
 * deliberate: `document.cookie` hands back every cookie the current host was
 * sent, so the `Domain` and `Secure` attributes that the *write* needs have
 * nothing to do with reading one back. The read is a string parse either way.
 *
 * The name is the only thing read from the policy, and it comes from the
 * projection — so a preview reads its own cookie and never production's, with no
 * call site able to ask for the wrong one.
 *
 * @param policy The cookie policy whose name to look for.
 * @returns The stored locale, or `null` when there is no cookie or its value is
 *   not a locale this platform has. A hand-edited or stale cookie reads as
 *   absent rather than throwing, so detection simply runs again.
 */
export function getLocaleFromCookie(
  policy?: PreferenceStorage | CookiePolicy,
): SupportedLocale | null {
  return readPreferenceLocale(policy);
}

/**
 * Forget the locale preference, so the next visit re-detects.
 *
 * Takes the same policy the write took, and that symmetry is the entire reason
 * this function has a parameter at all. A deletion whose `Domain` differs from
 * the original's does not remove the original: the browser stores it as a
 * separate host-only cookie with the same name, the read path finds whichever
 * comes first, and the preference appears to survive being cleared — which is
 * the bug this signature makes unrepresentable.
 *
 * It removes the colour mode too, because both live in the one cookie and
 * deleting half of a cookie is not an operation a browser offers. A caller that
 * wants only the language gone should rewrite the cookie with
 * {@link setPreferenceColorMode}; `LocalPreferenceStore.clear()` is the API for
 * "forget everything".
 *
 * @param policy Must be the policy {@link setLocaleCookie} used.
 */
export function removeLocaleCookie(
  policy?: PreferenceStorage | CookiePolicy,
): void {
  removePreferenceCookie(policy);
}

/**
 * The locale the browser asks for, in the platform's own vocabulary.
 *
 * Walks `navigator.languages` in preference order and takes the first entry
 * whose primary subtag this platform supports, so a browser set to
 * `["fr-FR", "vi-VN", "en-US"]` resolves to `vi` rather than falling straight
 * through to the default. `navigator.language` is the fallback for the older
 * engines that do not expose the list.
 *
 * @returns The detected locale, or the default when nothing matches.
 */
export function detectBrowserLocale(): SupportedLocale {
  if (typeof navigator === "undefined") {
    return DEFAULT_LOCALE;
  }

  const preferences: readonly string[] =
    navigator.languages?.length === 0
      ? []
      : (navigator.languages ?? [navigator.language ?? ""]);

  for (const preference of preferences) {
    // A BCP 47 tag is `language[-region][-script]`; the platform's locales are
    // primary subtags only, so the first segment is the whole comparison. Not
    // lowercased-and-matched loosely: `isSupportedLocale` is exact, and a
    // mismatch here should read as "unsupported", not as a silent fold.
    const primary = preference.split("-")[0]?.toLowerCase();
    if (primary !== undefined && isSupportedLocale(primary)) {
      return primary;
    }
  }

  return DEFAULT_LOCALE;
}

/**
 * The locale to open this app in.
 *
 * The order is cookie, then browser, then the platform default, and it is the
 * order every Ecoma frontend uses — the Vue apps call this, and the home page
 * reaches the same answer through `@nuxtjs/i18n`'s own detection configured with
 * the same cookie name from the same projection. That shared order is what makes
 * a language chosen in one app the language the next app opens in: the cookie is
 * written on the shared domain in production, and step one reads it before the
 * browser is ever consulted.
 *
 * Note that it does not *write* the cookie. A first-time visitor's detected
 * language is applied but not stored, so their next visit re-detects and follows
 * their browser if they change it. Storing it is the app's call, not this
 * function's: the home page's server-side redirect must not set a cookie on a
 * request that only wanted to be routed.
 *
 * @param policy The cookie policy to read under.
 * @returns The locale to use.
 */
export function getEffectiveLocale(
  policy?: PreferenceStorage | CookiePolicy,
): SupportedLocale {
  return getLocaleFromCookie(policy) ?? detectBrowserLocale();
}

export { setPreferenceColorMode } from "./preference-cookie.js";

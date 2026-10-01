import type { SupportedLocale } from "./types.js";
import {
  I18N_COOKIE_NAME,
  I18N_COOKIE_MAX_AGE,
  DEFAULT_LOCALE,
  I18N_COOKIE_DOMAIN_PRODUCTION,
  I18N_COOKIE_DOMAIN_DEVELOPMENT,
} from "./types.js";
import { isSupportedLocale } from "./locale.js";

/**
 * Cross-domain cookie storage for the locale preference.
 *
 * ## Why this file writes `document.cookie` itself
 *
 * There is no cookie library here, and that is a decision rather than an
 * omission. The whole surface is one cookie with no encoding, no signing and no
 * expiry parsing: `universal-cookie` is ~4 kB of package and a dependency that
 * `AGENTS.md` would want an architectural justification for, in exchange for
 * solving a problem this file does not have. The consequence worth stating is
 * that the attribute set below is the *only* place a locale cookie is defined,
 * so changing it changes all three frontends at once — which is the property a
 * library would have been bought for.
 *
 * ## Why `SameSite=Lax` and not `None`
 *
 * The three apps are `ecoma.io`, `admin.ecoma.io` and `id.ecoma.io` — different
 * origins, but reached by top-level navigation, not embedded. `Lax` permits
 * exactly that and blocks the cookie on cross-site subresource requests, which is
 * the only thing that would matter if the value were a credential. It is not:
 * the value is a two-letter language code, and the worst an attacker who could
 * set it is a page in the wrong language.
 *
 * `None` would require `Secure` and would additionally make the cookie readable
 * from a cross-origin iframe embedding any of these apps — a strictly larger
 * surface for a strictly less useful guarantee.
 */

/**
 * Whether a `document` is available.
 *
 * The Vue apps run in a browser and this module's tests run in jsdom, but the
 * home page renders on the server during prerender. `getEffectiveLocale` is
 * called before `app.mount()`, which on a prerendered page is server-side code.
 * Guarding here rather than at each call site keeps the guard from being
 * forgotten in the one function that gets added to this file next.
 */
function hasDocument(): boolean {
  return typeof document !== "undefined";
}

/**
 * The `Domain` attribute for the locale cookie.
 *
 * The leading dot is the older spelling of "and every subdomain"; it is what
 * makes a cookie written on `ecoma.io` readable on `admin.ecoma.io`, and every
 * browser still in use accepts it. A modern browser derives the same behaviour
 * from a bare `ecoma.io`, but the dot is written explicitly so the intent is
 * legible to whoever reads this next — the alternative reads as a bug.
 *
 * Development uses `localhost` rather than a `.localhost` domain: the three apps
 * run on different ports there, and **ports do not partition cookies**. A cookie
 * set on `localhost:5173` is visible to `localhost:8788`, which is what makes
 * the cross-app language sharing testable locally at all.
 */
function cookieDomain(isProduction: boolean): string {
  return isProduction
    ? I18N_COOKIE_DOMAIN_PRODUCTION
    : I18N_COOKIE_DOMAIN_DEVELOPMENT;
}

/**
 * Write the locale preference.
 *
 * @param locale The locale to remember.
 * @param isProduction Whether this is a production build. Controls `Domain`
 *   and `Secure`; see {@link cookieDomain}.
 */
export function setLocaleCookie(
  locale: SupportedLocale,
  isProduction: boolean,
): void {
  if (!hasDocument()) {
    return;
  }

  const parts = [
    `${I18N_COOKIE_NAME}=${encodeURIComponent(locale)}`,
    `Path=/`,
    `Domain=${cookieDomain(isProduction)}`,
    // See the file header for why this is Lax and not None.
    "SameSite=Lax",
    `Max-Age=${I18N_COOKIE_MAX_AGE}`,
  ];

  if (isProduction) {
    // Only meaningful over HTTPS, and a `Secure` cookie set on plain HTTP is
    // silently dropped by the browser — so this is conditional rather than
    // unconditional, or every local run would silently lose the preference.
    parts.push("Secure");
  }

  document.cookie = parts.join("; ");
}

/**
 * Read the locale preference.
 *
 * Takes no environment flag, and the absence is deliberate: `document.cookie`
 * hands back every cookie the current host was sent, so the `Domain` and
 * `Secure` attributes that the *write* needs have nothing to do with reading one
 * back. The read is a string parse either way.
 *
 * @returns The stored locale, or `null` when there is no cookie or its value is
 *   not a locale this platform has. A hand-edited or stale cookie reads as
 *   absent rather than throwing, so detection simply runs again.
 */
export function getLocaleFromCookie(): SupportedLocale | null {
  if (!hasDocument()) {
    return null;
  }

  for (const entry of document.cookie.split(";")) {
    const separator = entry.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const name = entry.slice(0, separator).trim();
    if (name !== I18N_COOKIE_NAME) {
      continue;
    }

    const value = decodeURIComponent(entry.slice(separator + 1).trim());
    return isSupportedLocale(value) ? value : null;
  }

  return null;
}

/**
 * Forget the locale preference, so the next visit re-detects.
 *
 * The `Domain` attribute is not optional here. A deletion without it produces a
 * host-only cookie that shadows the domain-scoped one rather than removing it,
 * and the preference would appear to survive being cleared.
 *
 * @param isProduction Whether this is a production build; must match the value
 *   passed to {@link setLocaleCookie} for the same deployment.
 */
export function removeLocaleCookie(isProduction: boolean): void {
  if (!hasDocument()) {
    return;
  }

  document.cookie = [
    `${I18N_COOKIE_NAME}=`,
    `Path=/`,
    `Domain=${cookieDomain(isProduction)}`,
    "SameSite=Lax",
    // Expire immediately. `Max-Age=0` is the modern spelling; `Expires` in the
    // past is the fallback for the same reason the deletion is explicit about
    // its domain — a browser that ignores one still honours the other.
    `Max-Age=0`,
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ].join("; ");
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
 * The order is cookie, then browser, then English, and it is the order every
 * Ecoma frontend uses — the Vue apps call this, and the home page reaches the
 * same answer through `@nuxtjs/i18n`'s own detection configured with the same
 * cookie name. That shared order is what makes a language chosen in one app
 * the language the next app opens in: the cookie is written on `.ecoma.io`, and
 * step one reads it before the browser is ever consulted.
 *
 * Note that it does not *write* the cookie. A first-time visitor's detected
 * language is applied but not stored, so their next visit re-detects and follows
 * their browser if they change it. Storing it is the app's call, not this
 * function's: the home page's server-side redirect must not set a cookie on a
 * request that only wanted to be routed.
 *
 * @returns The locale to use.
 */
export function getEffectiveLocale(): SupportedLocale {
  return getLocaleFromCookie() ?? detectBrowserLocale();
}
